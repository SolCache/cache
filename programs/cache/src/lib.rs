//! Cache: round-ups from every Solana trade, invested into xStocks.
//!
//! Security model
//! - Users keep custody. They approve this program's vault PDA as an SPL delegate on their
//!   USDC account, up to an allowance they choose.
//! - Only the configured keeper can start a sweep, and the program enforces, per sweep:
//!   the weekly cap, a destination owned by the user, a mint the user picked, a minimum
//!   output, and that the only instructions between `begin_sweep` and `end_sweep` are the
//!   configured swap program (Jupiter), compute-budget and associated-token instructions.
//! - The keeper decides *how much* to sweep (round-ups are computed off-chain). The program
//!   decides *what is allowed*.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    self as ix_sysvar, load_current_index_checked, load_instruction_at_checked,
};
use anchor_lang::Discriminator;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::TokenAccount as AnyTokenAccount;

declare_id!("11111111111111111111111111111111");

pub const MAX_PICKS: usize = 5;
pub const MAX_ALLOWED_MINTS: usize = 24;
pub const WEEK_SECONDS: i64 = 7 * 24 * 60 * 60;
/// USDC has 6 decimals.
pub const MIN_WEEKLY_CAP: u64 = 1_000_000; // $1
pub const MAX_WEEKLY_CAP: u64 = 100_000 * 1_000_000; // $100,000
pub const MULTIPLIERS: [u16; 7] = [1, 2, 5, 10, 20, 50, 100];

const COMPUTE_BUDGET_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("ComputeBudget111111111111111111111111111111");

#[program]
pub mod cache {
    use super::*;

    /// One-time setup. Only the program's upgrade authority can call it, so nobody can
    /// front-run the deploy and claim admin.
    pub fn init_config(
        ctx: Context<InitConfig>,
        keeper: Pubkey,
        swap_program: Pubkey,
        usdc_mint: Pubkey,
        allowed_mints: Vec<Pubkey>,
    ) -> Result<()> {
        require!(allowed_mints.len() <= MAX_ALLOWED_MINTS, CacheError::TooManyMints);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.keeper = keeper;
        config.swap_program = swap_program;
        config.usdc_mint = usdc_mint;
        config.paused = false;
        config.allowed_mints = allowed_mints;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        keeper: Option<Pubkey>,
        swap_program: Option<Pubkey>,
        paused: Option<bool>,
        allowed_mints: Option<Vec<Pubkey>>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(k) = keeper {
            config.keeper = k;
        }
        if let Some(s) = swap_program {
            config.swap_program = s;
        }
        if let Some(p) = paused {
            config.paused = p;
        }
        if let Some(m) = allowed_mints {
            require!(m.len() <= MAX_ALLOWED_MINTS, CacheError::TooManyMints);
            config.allowed_mints = m;
        }
        Ok(())
    }

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        picks: Vec<Pubkey>,
        weekly_cap: u64,
        multiplier: u16,
    ) -> Result<()> {
        validate_settings(&ctx.accounts.config, &picks, weekly_cap, multiplier)?;
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.picks = picks;
        vault.weekly_cap = weekly_cap;
        vault.multiplier = multiplier;
        vault.paused = false;
        vault.period_start = Clock::get()?.unix_timestamp;
        vault.spent_in_period = 0;
        vault.total_swept = 0;
        vault.sweep_count = 0;
        vault.sweep_active = false;
        vault.bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn update_vault(
        ctx: Context<UpdateVault>,
        picks: Vec<Pubkey>,
        weekly_cap: u64,
        multiplier: u16,
        paused: bool,
    ) -> Result<()> {
        validate_settings(&ctx.accounts.config, &picks, weekly_cap, multiplier)?;
        let vault = &mut ctx.accounts.vault;
        require!(!vault.sweep_active, CacheError::SweepInProgress);
        vault.picks = picks;
        vault.weekly_cap = weekly_cap;
        vault.multiplier = multiplier;
        vault.paused = paused;
        Ok(())
    }

    /// Closes the vault and refunds its rent. Clients pair this with an SPL `revoke`
    /// in the same transaction so the delegate approval is removed too.
    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        require!(!ctx.accounts.vault.sweep_active, CacheError::SweepInProgress);
        Ok(())
    }

    /// Moves `amount` USDC from the user to the keeper's USDC account so the keeper can
    /// route it through the swap program in the very next instructions. `end_sweep`
    /// later in the same transaction checks the user received at least `min_out`.
    pub fn begin_sweep(ctx: Context<BeginSweep>, amount: u64, min_out: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, CacheError::ProgramPaused);
        require!(amount > 0 && min_out > 0, CacheError::InvalidAmount);

        let dest = &ctx.accounts.dest;
        {
            let vault = &ctx.accounts.vault;
            require!(!vault.paused, CacheError::VaultPaused);
            require!(!vault.sweep_active, CacheError::SweepInProgress);
            require!(vault.picks.contains(&dest.mint), CacheError::MintNotPicked);
            require!(config.allowed_mints.contains(&dest.mint), CacheError::MintNotAllowed);
            require_keys_eq!(dest.owner, vault.owner, CacheError::WrongDestination);
        }

        check_sandwich(
            &ctx.accounts.instructions.to_account_info(),
            &config.swap_program,
        )?;

        // Weekly cap, rolling from the first sweep of each period.
        let now = Clock::get()?.unix_timestamp;
        let (period_start, spent) = {
            let vault = &ctx.accounts.vault;
            if now >= vault.period_start.saturating_add(WEEK_SECONDS) {
                (now, 0u64)
            } else {
                (vault.period_start, vault.spent_in_period)
            }
        };
        let new_spent = spent.checked_add(amount).ok_or(error!(CacheError::MathOverflow))?;
        require!(new_spent <= ctx.accounts.vault.weekly_cap, CacheError::WeeklyCapExceeded);

        // Pull USDC using the vault PDA's delegate approval.
        let owner = ctx.accounts.vault.owner;
        let bump_seed = [ctx.accounts.vault.bump];
        let seeds: [&[u8]; 3] = [b"vault", owner.as_ref(), &bump_seed];
        let signer = [&seeds[..]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.keeper_usdc.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &signer,
            ),
            amount,
        )?;

        let keeper_usdc_key = ctx.accounts.keeper_usdc.key();
        let keeper_usdc_before = ctx.accounts.keeper_usdc.amount; // snapshot taken before the CPI
        let dest_key = ctx.accounts.dest.key();
        let dest_before = ctx.accounts.dest.amount;

        let vault = &mut ctx.accounts.vault;
        vault.period_start = period_start;
        vault.spent_in_period = new_spent;
        vault.sweep_active = true;
        vault.sweep_amount = amount;
        vault.sweep_min_out = min_out;
        vault.sweep_dest = dest_key;
        vault.sweep_dest_before = dest_before;
        vault.sweep_keeper_usdc = keeper_usdc_key;
        vault.sweep_keeper_usdc_before = keeper_usdc_before;
        Ok(())
    }

    pub fn end_sweep(ctx: Context<EndSweep>) -> Result<()> {
        let dest_amount = ctx.accounts.dest.amount;
        let keeper_usdc_amount = ctx.accounts.keeper_usdc.amount;
        let mint = ctx.accounts.dest.mint;

        let vault = &mut ctx.accounts.vault;
        require!(vault.sweep_active, CacheError::NoSweepInProgress);

        let gained = dest_amount
            .checked_sub(vault.sweep_dest_before)
            .ok_or(error!(CacheError::SlippageExceeded))?;
        require!(gained >= vault.sweep_min_out, CacheError::SlippageExceeded);
        // The keeper must not end up holding any of the user's USDC.
        require!(
            keeper_usdc_amount <= vault.sweep_keeper_usdc_before,
            CacheError::KeeperKeptFunds
        );

        let usdc_in = vault.sweep_amount;
        vault.total_swept = vault
            .total_swept
            .checked_add(usdc_in)
            .ok_or(error!(CacheError::MathOverflow))?;
        vault.sweep_count = vault.sweep_count.saturating_add(1);
        vault.sweep_active = false;
        vault.sweep_amount = 0;
        vault.sweep_min_out = 0;

        emit!(SweepCompleted {
            owner: vault.owner,
            mint,
            usdc_in,
            out_amount: gained,
        });
        Ok(())
    }
}

fn validate_settings(
    config: &Config,
    picks: &[Pubkey],
    weekly_cap: u64,
    multiplier: u16,
) -> Result<()> {
    require!(!picks.is_empty() && picks.len() <= MAX_PICKS, CacheError::InvalidPicks);
    for (i, p) in picks.iter().enumerate() {
        require!(config.allowed_mints.contains(p), CacheError::MintNotAllowed);
        require!(!picks[..i].contains(p), CacheError::InvalidPicks);
    }
    require!(
        (MIN_WEEKLY_CAP..=MAX_WEEKLY_CAP).contains(&weekly_cap),
        CacheError::InvalidCap
    );
    require!(MULTIPLIERS.contains(&multiplier), CacheError::InvalidMultiplier);
    Ok(())
}

/// `begin_sweep` must be a top-level instruction followed, before any other Cache
/// instruction, by at least one swap-program instruction and then `end_sweep`.
/// Only compute-budget and associated-token instructions may sit in between.
fn check_sandwich(ix_sysvar_account: &AccountInfo, swap_program: &Pubkey) -> Result<()> {
    let current = load_current_index_checked(ix_sysvar_account)? as usize;
    let current_ix = load_instruction_at_checked(current, ix_sysvar_account)?;
    require_keys_eq!(current_ix.program_id, crate::ID, CacheError::CpiNotAllowed);

    let mut index = current + 1;
    let mut saw_swap = false;
    loop {
        let ix = load_instruction_at_checked(index, ix_sysvar_account)
            .map_err(|_| error!(CacheError::MissingEndSweep))?;
        if ix.program_id == crate::ID {
            require!(
                ix.data.starts_with(crate::instruction::EndSweep::DISCRIMINATOR),
                CacheError::InvalidSandwich
            );
            break;
        }
        if ix.program_id == *swap_program {
            saw_swap = true;
        } else if ix.program_id != COMPUTE_BUDGET_PROGRAM_ID
            && ix.program_id != anchor_spl::associated_token::ID
        {
            return err!(CacheError::InvalidSandwich);
        }
        index += 1;
    }
    require!(saw_swap, CacheError::InvalidSandwich);
    Ok(())
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::Cache>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ CacheError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ CacheError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateVault<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner @ CacheError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(mut, close = owner, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner @ CacheError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct BeginSweep<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = keeper @ CacheError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub keeper: Signer<'info>,
    #[account(
        mut,
        constraint = user_usdc.mint == config.usdc_mint @ CacheError::WrongMint,
        constraint = user_usdc.owner == vault.owner @ CacheError::WrongSource
    )]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = keeper_usdc.mint == config.usdc_mint @ CacheError::WrongMint,
        constraint = keeper_usdc.owner == keeper.key() @ CacheError::Unauthorized
    )]
    pub keeper_usdc: Account<'info, TokenAccount>,
    /// The user's xStock account (Token-2022 or classic SPL).
    pub dest: InterfaceAccount<'info, AnyTokenAccount>,
    pub token_program: Program<'info, Token>,
    /// CHECK: verified by address.
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct EndSweep<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = keeper @ CacheError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub keeper: Signer<'info>,
    #[account(address = vault.sweep_keeper_usdc @ CacheError::Unauthorized)]
    pub keeper_usdc: Account<'info, TokenAccount>,
    #[account(address = vault.sweep_dest @ CacheError::WrongDestination)]
    pub dest: InterfaceAccount<'info, AnyTokenAccount>,
}

// ---------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub swap_program: Pubkey,
    pub usdc_mint: Pubkey,
    pub paused: bool,
    #[max_len(24)]
    pub allowed_mints: Vec<Pubkey>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    #[max_len(5)]
    pub picks: Vec<Pubkey>,
    pub weekly_cap: u64,
    pub multiplier: u16,
    pub paused: bool,
    pub period_start: i64,
    pub spent_in_period: u64,
    pub total_swept: u64,
    pub sweep_count: u64,
    pub sweep_active: bool,
    pub sweep_amount: u64,
    pub sweep_min_out: u64,
    pub sweep_dest: Pubkey,
    pub sweep_dest_before: u64,
    pub sweep_keeper_usdc: Pubkey,
    pub sweep_keeper_usdc_before: u64,
    pub bump: u8,
}

#[event]
pub struct SweepCompleted {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub usdc_in: u64,
    pub out_amount: u64,
}

#[error_code]
pub enum CacheError {
    #[msg("Not authorized")]
    Unauthorized,
    #[msg("Too many allowed mints")]
    TooManyMints,
    #[msg("Pick between 1 and 5 different allowed stocks")]
    InvalidPicks,
    #[msg("Weekly cap must be between $1 and $100,000")]
    InvalidCap,
    #[msg("Multiplier must be 1, 2, 5, 10, 20, 50 or 100")]
    InvalidMultiplier,
    #[msg("Cache is paused")]
    ProgramPaused,
    #[msg("This vault is paused")]
    VaultPaused,
    #[msg("A sweep is already in progress")]
    SweepInProgress,
    #[msg("No sweep in progress")]
    NoSweepInProgress,
    #[msg("Amount and minimum output must be greater than zero")]
    InvalidAmount,
    #[msg("This stock is not one of the user's picks")]
    MintNotPicked,
    #[msg("This stock is not on the allowlist")]
    MintNotAllowed,
    #[msg("Destination must be the user's own token account")]
    WrongDestination,
    #[msg("Source must be the user's USDC account")]
    WrongSource,
    #[msg("Wrong token mint")]
    WrongMint,
    #[msg("This sweep would exceed the weekly cap")]
    WeeklyCapExceeded,
    #[msg("Received less than the minimum output")]
    SlippageExceeded,
    #[msg("Keeper kept part of the user's USDC")]
    KeeperKeptFunds,
    #[msg("begin_sweep cannot be called from another program")]
    CpiNotAllowed,
    #[msg("end_sweep must follow begin_sweep in the same transaction")]
    MissingEndSweep,
    #[msg("Only swap, compute-budget and token-account instructions may sit inside a sweep")]
    InvalidSandwich,
    #[msg("Math overflow")]
    MathOverflow,
}

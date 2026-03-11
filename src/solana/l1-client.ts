import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  AccountMeta,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  ConfirmedSignatureInfo,
  ParsedTransactionWithMeta,
  GetVersionedTransactionConfig,
} from "@solana/web3.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

// Seeds matching the L1 bridge program
const BRIDGE_CONFIG_SEED = Buffer.from("bridge_config");
const WITHDRAWAL_SEED = Buffer.from("withdrawal");
const VAULT_SEED = Buffer.from("vault");
const SOL_VAULT_SEED = Buffer.from("sol_vault");

// Instruction discriminators
const IX_INITIATE_WITHDRAWAL = 3;
const IX_FINALIZE_WITHDRAWAL = 5;

export class L1Client {
  readonly connection: Connection;
  readonly bridgeProgram: PublicKey;
  readonly relayer: Keypair;

  constructor(relayerKeypair: Keypair) {
    this.connection = new Connection(config.L1_RPC_URL, {
      commitment: "confirmed",
      disableRetryOnRateLimit: false,
    });
    this.bridgeProgram = new PublicKey(config.L1_BRIDGE_PROGRAM);
    this.relayer = relayerKeypair;
  }

  // Fetch recent signatures for the L1 bridge program
  async getRecentSignatures(
    before?: string,
    limit: number = config.SIGNATURES_FETCH_LIMIT
  ): Promise<ConfirmedSignatureInfo[]> {
    try {
      const opts: { limit: number; before?: string } = { limit };
      if (before) opts.before = before;
      return await this.connection.getSignaturesForAddress(
        this.bridgeProgram,
        opts
      );
    } catch (err) {
      logger.error({ err }, "L1: Failed to fetch signatures");
      return [];
    }
  }

  // Fetch and parse a single transaction
  async getTransaction(
    signature: string
  ): Promise<ParsedTransactionWithMeta | null> {
    try {
      const txConfig: GetVersionedTransactionConfig = {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      };
      // Use getParsedTransaction to get structured account/log data
      const tx = await this.connection.getParsedTransaction(
        signature,
        txConfig
      );
      return tx;
    } catch (err) {
      logger.warn({ err, signature }, "L1: Failed to fetch transaction");
      return null;
    }
  }

  // Derive the bridge config PDA
  bridgeConfigPda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [BRIDGE_CONFIG_SEED],
      this.bridgeProgram
    );
    return pda;
  }

  // Derive a withdrawal PDA for a given nonce
  withdrawalPda(nonce: bigint): PublicKey {
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(nonce);
    const [pda] = PublicKey.findProgramAddressSync(
      [WITHDRAWAL_SEED, nonceBuffer],
      this.bridgeProgram
    );
    return pda;
  }

  // Derive the token vault PDA for a given mint
  vaultPda(tokenMint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, tokenMint.toBuffer()],
      this.bridgeProgram
    );
    return pda;
  }

  // Derive the SOL vault PDA
  solVaultPda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [SOL_VAULT_SEED],
      this.bridgeProgram
    );
    return pda;
  }

  /**
   * Build and send an InitiateWithdrawal instruction on L1.
   * This is called by the relayer after observing a BurnWrapped event on L2.
   * The relayer acts as the sequencer and posts the withdrawal to L1 to begin
   * the 7-day challenge period.
   */
  async initiateWithdrawal(params: {
    recipient: PublicKey;
    amount: bigint;
    tokenMint: PublicKey;
    nonce: bigint;
    merkleProof?: Uint8Array;
  }): Promise<string> {
    const configPda = this.bridgeConfigPda();
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(params.nonce);
    const [withdrawalPda] = PublicKey.findProgramAddressSync(
      [WITHDRAWAL_SEED, nonceBuffer],
      this.bridgeProgram
    );

    // Build instruction data:
    //   byte[0]:  discriminator (3)
    //   bytes[1-32]:  recipient pubkey
    //   bytes[33-40]: amount u64 LE
    //   bytes[41-72]: token_mint pubkey
    //   bytes[73-104]: merkle_proof [u8; 32]
    //   bytes[105-112]: nonce u64 LE
    const data = Buffer.alloc(113);
    data.writeUInt8(IX_INITIATE_WITHDRAWAL, 0);
    params.recipient.toBuffer().copy(data, 1);

    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(params.amount);
    amountBuf.copy(data, 33);

    params.tokenMint.toBuffer().copy(data, 41);

    const proof = params.merkleProof ?? new Uint8Array(32);
    Buffer.from(proof).copy(data, 73);

    nonceBuffer.copy(data, 105);

    const accounts: AccountMeta[] = [
      { pubkey: this.relayer.publicKey, isSigner: true, isWritable: false }, // sequencer
      { pubkey: this.relayer.publicKey, isSigner: true, isWritable: true },  // payer
      { pubkey: withdrawalPda, isSigner: false, isWritable: true },          // withdrawal PDA
      { pubkey: configPda, isSigner: false, isWritable: true },              // bridge config (writable for program check)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ];

    const ix = new TransactionInstruction({
      programId: this.bridgeProgram,
      keys: accounts,
      data,
    });

    return this.sendTransaction([ix]);
  }

  /**
   * Build and send a FinalizeWithdrawal instruction on L1.
   * Called after the challenge period expires and no fraud proof was submitted.
   */
  async finalizeWithdrawal(params: {
    nonce: bigint;
    tokenMint: PublicKey;
    recipientTokenAccount: PublicKey;
  }): Promise<string> {
    const configPda = this.bridgeConfigPda();
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(params.nonce);
    const [withdrawalPda] = PublicKey.findProgramAddressSync(
      [WITHDRAWAL_SEED, nonceBuffer],
      this.bridgeProgram
    );
    const vaultToken = this.vaultPda(params.tokenMint);

    // Instruction data: discriminator(1) + nonce(8)
    const data = Buffer.alloc(9);
    data.writeUInt8(IX_FINALIZE_WITHDRAWAL, 0);
    nonceBuffer.copy(data, 1);

    const accounts: AccountMeta[] = [
      { pubkey: this.relayer.publicKey, isSigner: true, isWritable: true },  // payer
      { pubkey: withdrawalPda, isSigner: false, isWritable: true },          // withdrawal PDA
      { pubkey: vaultToken, isSigner: false, isWritable: true },             // vault token account
      { pubkey: params.recipientTokenAccount, isSigner: false, isWritable: true }, // recipient ATA
      { pubkey: params.tokenMint, isSigner: false, isWritable: false },      // token mint
      { pubkey: configPda, isSigner: false, isWritable: false },             // bridge config
      { pubkey: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), isSigner: false, isWritable: false }, // token-2022 program
    ];

    const ix = new TransactionInstruction({
      programId: this.bridgeProgram,
      keys: accounts,
      data,
    });

    return this.sendTransaction([ix]);
  }



  /**
   * Find the next available L1 withdrawal nonce.
   * Starts from the given nonce and increments until an unused PDA is found.
   */
  async findAvailableL1Nonce(startNonce: bigint): Promise<bigint> {
    let nonce = startNonce;
    for (let i = 0; i < 100; i++) {
      const pda = this.withdrawalPda(nonce);
      const info = await this.connection.getAccountInfo(pda);
      if (info === null) {
        return nonce;
      }
      logger.debug({ nonce: nonce.toString() }, "L1 nonce already used, trying next");
      nonce++;
    }
    throw new Error("Could not find available L1 nonce after 100 attempts");
  }

    // Token-2022 program and ATA program
  static readonly TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  static readonly ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

  /**
   * Derive the Token-2022 Associated Token Account for a wallet + mint.
   */
  static getToken2022ATA(owner: PublicKey, mint: PublicKey): PublicKey {
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), L1Client.TOKEN_2022_PROGRAM.toBuffer(), mint.toBuffer()],
      L1Client.ATA_PROGRAM
    );
    return ata;
  }

  /**
   * Find or create a token account for the recipient.
   * First checks for any existing token accounts (wallet-created ATAs may use
   * non-standard derivation). Falls back to creating a Token-2022 ATA.
   */
  async ensureRecipientATA(
    recipient: PublicKey,
    tokenMint: PublicKey
  ): Promise<PublicKey> {
    // First: check for ANY existing token accounts for this mint owned by recipient
    try {
      const accounts = await this.connection.getTokenAccountsByOwner(recipient, {
        mint: tokenMint,
      });
      if (accounts.value.length > 0) {
        const existing = accounts.value[0].pubkey;
        logger.info(
          { recipient: recipient.toBase58(), ata: existing.toBase58() },
          "L1: Found existing token account for recipient"
        );
        return existing;
      }
    } catch (err) {
      logger.warn({ err }, "L1: Failed to query token accounts, will try ATA creation");
    }

    // No existing account found — create Token-2022 ATA
    const ata = L1Client.getToken2022ATA(recipient, tokenMint);
    logger.info(
      { recipient: recipient.toBase58(), mint: tokenMint.toBase58(), ata: ata.toBase58() },
      "L1: Creating Token-2022 ATA for recipient"
    );

    const keys = [
      { pubkey: this.relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: false },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: L1Client.TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
    ];

    const ix = new TransactionInstruction({
      programId: L1Client.ATA_PROGRAM,
      keys,
      data: Buffer.from([1]), // CreateIdempotent
    });

    await this.sendTransaction([ix]);
    return ata;
  }

    // Internal: build, sign and send a transaction with retry
  async sendTransaction(
    instructions: TransactionInstruction[],
    maxRetries: number = 3
  ): Promise<string> {
    let lastError: unknown;

    // Prepend a compute budget instruction for priority fees
    const computeIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 1000,
    });

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const { blockhash, lastValidBlockHeight } =
          await this.connection.getLatestBlockhash("confirmed");

        const tx = new Transaction();
        tx.add(computeIx, ...instructions);
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.relayer.publicKey;

        const sig = await sendAndConfirmTransaction(
          this.connection,
          tx,
          [this.relayer],
          {
            commitment: "confirmed",
            maxRetries: 2,
            skipPreflight: true,
          }
        );
        return sig;
      } catch (err) {
        lastError = err;
        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        logger.warn(
          { err, attempt: attempt + 1, maxRetries },
          `L1: tx failed, retrying in ${delay}ms`
        );
        await sleep(delay);
      }
    }

    throw lastError;
  }

// ── IX 12: SequencerWithdrawSOL ─────────────────────────────────────────────
  // Allows the sequencer (relayer) to withdraw SOL from the bridge vault PDA
  // so it can fund PumpSwap swaps using the deposited SOL itself.

  async withdrawSolFromVault(amount: bigint): Promise<string> {
    const configPda = this.bridgeConfigPda();
    const solVault = this.solVaultPda();

    // Instruction data: [12 (u8)] + [amount (u64 LE)] = 9 bytes
    const data = Buffer.alloc(9);
    data.writeUInt8(12, 0); // IX_SEQUENCER_WITHDRAW_SOL
    data.writeBigUInt64LE(amount, 1);

    const accounts: AccountMeta[] = [
      { pubkey: this.relayer.publicKey, isSigner: true, isWritable: true },   // sequencer
      { pubkey: solVault, isSigner: false, isWritable: true },                // sol_vault PDA
      { pubkey: configPda, isSigner: false, isWritable: false },              // bridge_config
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ];

    const ix = new TransactionInstruction({
      programId: this.bridgeProgram,
      keys: accounts,
      data,
    });

    logger.info({
      amount: amount.toString(),
      solReadable: (Number(amount) / 1e9).toFixed(4),
      vault: solVault.toBase58(),
    }, "L1: Withdrawing SOL from bridge vault for PumpSwap");

    return this.sendTransaction([ix]);
  }

    // Extract log messages from a parsed transaction
  static extractLogs(tx: ParsedTransactionWithMeta): string[] {
    return tx.meta?.logMessages ?? [];
  }

  // Parse a LockTokens / Deposit event from L1 bridge logs
  static parseDepositEvent(logs: string[]): DepositEvent | null {
    for (const log of logs) {
      // Matches: "Program log: EVENT:Deposit:{...}" or "Program log: EVENT:DepositSOL:{...}"
      const depositMatch = log.match(
        /^Program log: EVENT:Deposit:(\{.+\})$/
      );
      const depositSolMatch = log.match(
        /^Program log: EVENT:DepositSOL:(\{.+\})$/
      );
      const raw = depositMatch?.[1] ?? depositSolMatch?.[1];
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as {
            depositor: string;
            l2_recipient: string;
            amount: number;
            token_mint?: string;
            nonce: number;
          };
          return {
            depositor: parsed.depositor,
            l2Recipient: parsed.l2_recipient,
            amount: BigInt(parsed.amount),
            tokenMint: parsed.token_mint ?? "SOL",
            nonce: BigInt(parsed.nonce),
            isSol: !depositMatch,
          };
        } catch {
          // malformed JSON — skip
        }
      }
    }
    return null;
  }
}

export interface DepositEvent {
  depositor: string;
  l2Recipient: string; // hex-encoded 32 bytes
  amount: bigint;
  tokenMint: string;
  nonce: bigint;
  isSol: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

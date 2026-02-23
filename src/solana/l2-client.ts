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

// Seeds matching the L2 bridge program (bridge-l2/src/lib.rs)
const L2_BRIDGE_CONFIG_SEED = Buffer.from("l2_bridge_config");
const WRAPPED_MINT_SEED = Buffer.from("wrapped_mint");
const PROCESSED_SEED = Buffer.from("processed");
const MINT_SEED = Buffer.from("mint");

// Instruction discriminators
const IX_MINT_WRAPPED = 2;

export class L2Client {
  readonly connection: Connection;
  readonly bridgeProgram: PublicKey;
  readonly relayer: Keypair;

  constructor(relayerKeypair: Keypair) {
    this.connection = new Connection(config.L2_RPC_URL, {
      commitment: "confirmed",
      disableRetryOnRateLimit: false,
    });
    this.bridgeProgram = new PublicKey(config.L2_BRIDGE_PROGRAM);
    this.relayer = relayerKeypair;
  }

  // Fetch recent signatures for the L2 bridge program
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
      logger.error({ err }, "L2: Failed to fetch signatures");
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
      const tx = await this.connection.getParsedTransaction(
        signature,
        txConfig
      );
      return tx;
    } catch (err) {
      logger.warn({ err, signature }, "L2: Failed to fetch transaction");
      return null;
    }
  }

  // Derive the L2 bridge config PDA
  bridgeConfigPda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [L2_BRIDGE_CONFIG_SEED],
      this.bridgeProgram
    );
    return pda;
  }

  // Derive wrapped_token_info PDA for a given L1 mint
  wrappedTokenInfoPda(l1Mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [WRAPPED_MINT_SEED, l1Mint.toBuffer()],
      this.bridgeProgram
    );
    return pda;
  }

  // Derive the L2 SPL mint PDA for a given L1 mint
  l2MintPda(l1Mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [MINT_SEED, l1Mint.toBuffer()],
      this.bridgeProgram
    );
    return pda;
  }

  // Derive the processed_deposit PDA for a given L1 deposit nonce
  processedDepositPda(nonce: bigint): PublicKey {
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(nonce);
    const [pda] = PublicKey.findProgramAddressSync(
      [PROCESSED_SEED, nonceBuffer],
      this.bridgeProgram
    );
    return pda;
  }

  /**
   * Derive the Associated Token Account address for a wallet + mint.
   * Uses the canonical ATA derivation: seeds = [wallet, token_program, mint].
   * We replicate this here to avoid importing @solana/spl-token.
   */
  static getAssociatedTokenAddress(
    owner: PublicKey,
    mint: PublicKey
  ): PublicKey {
    const SPL_TOKEN_PROGRAM = new PublicKey(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    );
    const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bbd"
    );
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), SPL_TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM
    );
    return ata;
  }

  /**
   * Build and submit a MintWrapped instruction on L2.
   * Called by the deposit processor after confirming an L1 LockTokens event.
   *
   * Account layout (matches process_mint_wrapped in bridge-l2/src/lib.rs):
   *   0. [signer]          relayer
   *   1. [signer, writable] payer (= relayer)
   *   2. []                l2_bridge_config PDA
   *   3. []                wrapped_token_info PDA
   *   4. [writable]        l2_mint PDA
   *   5. [writable]        recipient ATA
   *   6. [writable]        processed_deposit PDA
   *   7. []                token_program
   *   8. []                system_program
   */
  async mintWrapped(params: {
    l1Mint: PublicKey;
    recipient: PublicKey;
    amount: bigint;
    depositNonce: bigint;
    l1TxSignature: Uint8Array; // 64 bytes
  }): Promise<string> {
    const configPda = this.bridgeConfigPda();
    const wrappedInfoPda = this.wrappedTokenInfoPda(params.l1Mint);
    const l2MintPda = this.l2MintPda(params.l1Mint);
    const processedPda = this.processedDepositPda(params.depositNonce);
    const recipientAta = L2Client.getAssociatedTokenAddress(
      params.recipient,
      l2MintPda
    );

    const SPL_TOKEN_PROGRAM = new PublicKey(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    );

    // Build instruction data (matches MintWrappedParams in Borsh encoding):
    //   byte[0]:     discriminator (2)
    //   bytes[1-8]:  l1_deposit_nonce u64 LE
    //   bytes[9-40]: recipient Pubkey (32 bytes)
    //   bytes[41-48]: amount u64 LE
    //   bytes[49-80]: l1_mint Pubkey (32 bytes)
    //   bytes[81-144]: l1_tx_signature [u8; 64]
    const data = Buffer.alloc(145);
    data.writeUInt8(IX_MINT_WRAPPED, 0);

    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(params.depositNonce);
    nonceBuf.copy(data, 1);

    params.recipient.toBuffer().copy(data, 9);

    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(params.amount);
    amountBuf.copy(data, 41);

    params.l1Mint.toBuffer().copy(data, 49);

    const sig64 = Buffer.alloc(64, 0);
    Buffer.from(params.l1TxSignature).copy(sig64, 0);
    sig64.copy(data, 81);

    const accounts: AccountMeta[] = [
      { pubkey: this.relayer.publicKey, isSigner: true, isWritable: false },  // relayer (signer)
      { pubkey: this.relayer.publicKey, isSigner: true, isWritable: true },   // payer (signer, writable)
      { pubkey: configPda, isSigner: false, isWritable: false },               // l2_bridge_config
      { pubkey: wrappedInfoPda, isSigner: false, isWritable: false },          // wrapped_token_info
      { pubkey: l2MintPda, isSigner: false, isWritable: true },                // l2_mint
      { pubkey: recipientAta, isSigner: false, isWritable: true },             // recipient ATA
      { pubkey: processedPda, isSigner: false, isWritable: true },             // processed_deposit
      { pubkey: SPL_TOKEN_PROGRAM, isSigner: false, isWritable: false },       // token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ];

    const ix = new TransactionInstruction({
      programId: this.bridgeProgram,
      keys: accounts,
      data,
    });

    return this.sendTransaction([ix]);
  }

  // Internal: build, sign and send a transaction with retry
  async sendTransaction(
    instructions: TransactionInstruction[],
    maxRetries: number = 3
  ): Promise<string> {
    let lastError: unknown;

    const computeIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 1000,
    });

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const { blockhash } =
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
          }
        );
        return sig;
      } catch (err) {
        lastError = err;
        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        logger.warn(
          { err, attempt: attempt + 1, maxRetries },
          `L2: tx failed, retrying in ${delay}ms`
        );
        await sleep(delay);
      }
    }

    throw lastError;
  }

  // Extract log messages from a parsed transaction
  static extractLogs(tx: ParsedTransactionWithMeta): string[] {
    return tx.meta?.logMessages ?? [];
  }

  /**
   * Parse a BurnWrapped event from L2 bridge log messages.
   * Matches: "Program log: EVENT:BurnWrapped:{...}"
   */
  static parseBurnEvent(logs: string[]): BurnEvent | null {
    for (const log of logs) {
      const match = log.match(/^Program log: EVENT:BurnWrapped:(\{.+\})$/);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]) as {
            burner: string;
            l1_recipient: string;
            amount: number;
            l1_mint: string;
            burn_nonce: number;
          };
          return {
            burner: parsed.burner,
            l1Recipient: parsed.l1_recipient, // hex-encoded 32 bytes
            amount: BigInt(parsed.amount),
            l1Mint: parsed.l1_mint,
            burnNonce: BigInt(parsed.burn_nonce),
          };
        } catch {
          // malformed JSON — skip
        }
      }
    }
    return null;
  }
}

export interface BurnEvent {
  burner: string;
  l1Recipient: string; // hex-encoded 32 bytes
  amount: bigint;
  l1Mint: string;
  burnNonce: bigint;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

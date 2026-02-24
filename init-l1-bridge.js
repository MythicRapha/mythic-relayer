// Initialize the L1 Bridge after deployment + create MYTH vault + send remainder back
// Run on server: cd /mnt/data/mythic-relayer && node init-l1-bridge.js <RETURN_ADDRESS>
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────
const L1_RPC = 'https://mainnet.helius-rpc.com/?api-key=5ef91a09-b6c1-4993-ae22-a203db16ae0f';
const BRIDGE_L1_PROGRAM_ID = new PublicKey('oEQfREm4FQkaVeRoxJHkJLB1feHprrntY6eJuW2zbqQ');
const MYTH_L1_MINT = new PublicKey('5UP2iL9DefXC3yovX9b4XG2EiCnyxuVo3S2F6ik5pump');

const BRIDGE_CONFIG_SEED = Buffer.from('bridge_config');
const VAULT_SEED = Buffer.from('vault');
const SOL_VAULT_SEED = Buffer.from('sol_vault');

// ── Helpers ─────────────────────────────────────────────────────────────────
function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function serializeU64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function serializeI64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(value));
  return buf;
}

// ── Build Initialize Instruction ────────────────────────────────────────────
// Instruction data: [0] + InitializeParams(sequencer: Pubkey, challenge_period: i64)
function buildInitializeIx(admin, sequencer, challengePeriod) {
  const [configPda] = PublicKey.findProgramAddressSync(
    [BRIDGE_CONFIG_SEED],
    BRIDGE_L1_PROGRAM_ID
  );

  // Borsh: sequencer (32 bytes) + challenge_period (i64, 8 bytes)
  const data = Buffer.concat([
    Buffer.from([0]), // IX_INITIALIZE
    sequencer.toBuffer(),
    serializeI64(challengePeriod),
  ]);

  return new TransactionInstruction({
    programId: BRIDGE_L1_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const returnAddress = process.argv[2];
  
  const connection = new Connection(L1_RPC, 'confirmed');
  const deployer = loadKeypair('/mnt/data/mythic-l2/keys/deployer.json');
  
  console.log('=== Mythic L1 Bridge Initialization ===');
  console.log('Deployer: ', deployer.publicKey.toBase58());
  console.log('Program:  ', BRIDGE_L1_PROGRAM_ID.toBase58());
  console.log('MYTH Mint:', MYTH_L1_MINT.toBase58());
  console.log();
  
  const [configPda] = PublicKey.findProgramAddressSync(
    [BRIDGE_CONFIG_SEED], BRIDGE_L1_PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, MYTH_L1_MINT.toBuffer()], BRIDGE_L1_PROGRAM_ID
  );
  const [solVaultPda] = PublicKey.findProgramAddressSync(
    [SOL_VAULT_SEED], BRIDGE_L1_PROGRAM_ID
  );
  
  console.log('Config PDA:   ', configPda.toBase58());
  console.log('MYTH Vault PDA:', vaultPda.toBase58());
  console.log('SOL Vault PDA: ', solVaultPda.toBase58());
  console.log();
  
  const startBalance = await connection.getBalance(deployer.publicKey);
  console.log('Start balance:', (startBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
  
  // Step 1: Initialize the bridge
  const existingConfig = await connection.getAccountInfo(configPda);
  if (existingConfig) {
    console.log('Bridge already initialized, skipping...');
  } else {
    console.log('Step 1: Initializing L1 Bridge...');
    const challengePeriod = 604800; // 7 days
    
    try {
      const initIx = buildInitializeIx(deployer.publicKey, deployer.publicKey, challengePeriod);
      const initTx = new Transaction().add(initIx);
      initTx.feePayer = deployer.publicKey;
      const { blockhash } = await connection.getLatestBlockhash();
      initTx.recentBlockhash = blockhash;
      const initSig = await sendAndConfirmTransaction(connection, initTx, [deployer]);
      console.log('  Bridge initialized:', initSig);
    } catch (e) {
      console.error('  Init failed:', e.message);
      if (e.logs) console.error('  Logs:', e.logs.join('\n'));
      return;
    }
  }
  
  // Step 2: Create MYTH vault via IX_CREATE_VAULT (instruction 11)
  // The vault PDA ([VAULT_SEED, mint]) is a token account whose authority is itself.
  // The bridge program creates it via invoke_signed.
  // MYTH on L1 is Token-2022 so we pass Token-2022 program ID.
  console.log();
  console.log('Step 2: Creating MYTH vault token account...');
  
  const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const RENT_SYSVAR = new PublicKey('SysvarRent111111111111111111111111111111111');
  
  const vaultAccount = await connection.getAccountInfo(vaultPda);
  if (vaultAccount) {
    console.log('  Vault already exists at', vaultPda.toBase58());
  } else {
    console.log('  Creating vault via CreateVault instruction (IX 11)...');
    try {
      const createVaultIx = new TransactionInstruction({
        programId: BRIDGE_L1_PROGRAM_ID,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },   // admin (payer)
          { pubkey: vaultPda, isSigner: false, isWritable: true },            // vault PDA
          { pubkey: MYTH_L1_MINT, isSigner: false, isWritable: false },       // token mint
          { pubkey: configPda, isSigner: false, isWritable: false },          // bridge_config
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // token program (Token-2022)
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
          { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },        // rent sysvar
        ],
        data: Buffer.from([11]), // IX_CREATE_VAULT
      });
      
      const vaultTx = new Transaction().add(createVaultIx);
      vaultTx.feePayer = deployer.publicKey;
      const { blockhash: bh2 } = await connection.getLatestBlockhash();
      vaultTx.recentBlockhash = bh2;
      const vaultSig = await sendAndConfirmTransaction(connection, vaultTx, [deployer]);
      console.log('  Vault created:', vaultSig);
      console.log('  Vault PDA:', vaultPda.toBase58());
    } catch (e) {
      console.error('  CreateVault failed:', e.message);
      if (e.logs) console.error('  Logs:', e.logs.join('\n'));
      return;
    }
  }

  // Step 3: Report final balance & return remainder
  const endBalance = await connection.getBalance(deployer.publicKey);
  console.log();
  console.log('=== Final State ===');
  console.log('Remaining balance:', (endBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
  
  if (returnAddress && endBalance > 10000) {
    const keepForFees = 0.01 * LAMPORTS_PER_SOL; // keep 0.01 SOL for future txns
    const returnAmount = endBalance - keepForFees;
    
    if (returnAmount > 0) {
      console.log();
      console.log('Step 3: Returning', (returnAmount / LAMPORTS_PER_SOL).toFixed(6), 'SOL to', returnAddress);
      
      try {
        const returnTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: deployer.publicKey,
            toPubkey: new PublicKey(returnAddress),
            lamports: Math.floor(returnAmount),
          })
        );
        const returnSig = await sendAndConfirmTransaction(connection, returnTx, [deployer]);
        console.log('  Returned:', returnSig);
        
        const finalBal = await connection.getBalance(deployer.publicKey);
        console.log('  Deployer final balance:', (finalBal / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
      } catch (e) {
        console.error('  Return failed:', e.message);
      }
    }
  } else if (!returnAddress) {
    console.log('  Pass a return address as argument to send remainder back');
    console.log('  Usage: node init-l1-bridge.js <SOLANA_ADDRESS>');
  }
}

main().catch(console.error);

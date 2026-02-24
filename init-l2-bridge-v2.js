// Initialize the L2 Bridge (upgradeable program) and fund the reserve
// Uses: 5t8JwXzGQ3c7PCY6p6oJqZgFt8gff2d6uTLrqa1jFrKP
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────
const L2_RPC = 'http://127.0.0.1:8899';
const BRIDGE_L2_PROGRAM_ID = new PublicKey('5t8JwXzGQ3c7PCY6p6oJqZgFt8gff2d6uTLrqa1jFrKP');

const L2_BRIDGE_CONFIG_SEED = Buffer.from('l2_bridge_config');
const BRIDGE_RESERVE_SEED = Buffer.from('bridge_reserve');

const IX_INITIALIZE = 0;
const IX_FUND_RESERVE = 1;

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

// ── Build Instructions ──────────────────────────────────────────────────────
function buildInitializeIx(admin, relayer) {
  const [configPda] = PublicKey.findProgramAddressSync(
    [L2_BRIDGE_CONFIG_SEED],
    BRIDGE_L2_PROGRAM_ID
  );

  const data = Buffer.concat([
    Buffer.from([IX_INITIALIZE]),
    relayer.toBuffer(),
  ]);

  return new TransactionInstruction({
    programId: BRIDGE_L2_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildFundReserveIx(funder, amount) {
  const [configPda] = PublicKey.findProgramAddressSync(
    [L2_BRIDGE_CONFIG_SEED],
    BRIDGE_L2_PROGRAM_ID
  );
  const [reservePda] = PublicKey.findProgramAddressSync(
    [BRIDGE_RESERVE_SEED],
    BRIDGE_L2_PROGRAM_ID
  );

  const data = Buffer.concat([
    Buffer.from([IX_FUND_RESERVE]),
    serializeU64(amount),
  ]);

  return new TransactionInstruction({
    programId: BRIDGE_L2_PROGRAM_ID,
    keys: [
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: reservePda, isSigner: false, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const connection = new Connection(L2_RPC, 'confirmed');
  
  const deployer = loadKeypair('/mnt/data/mythic-l2/keys/deployer.json');
  const foundation = loadKeypair('/mnt/data/mythic-l2/keys/foundation.json');
  
  console.log('=== Mythic L2 Bridge Initialization ===');
  console.log('Deployer:  ', deployer.publicKey.toBase58());
  console.log('Foundation:', foundation.publicKey.toBase58());
  console.log('Program:   ', BRIDGE_L2_PROGRAM_ID.toBase58());
  
  const [configPda] = PublicKey.findProgramAddressSync(
    [L2_BRIDGE_CONFIG_SEED],
    BRIDGE_L2_PROGRAM_ID
  );
  const [reservePda] = PublicKey.findProgramAddressSync(
    [BRIDGE_RESERVE_SEED],
    BRIDGE_L2_PROGRAM_ID
  );
  
  console.log('Config PDA:', configPda.toBase58());
  console.log('Reserve PDA:', reservePda.toBase58());
  console.log();
  
  // Check if already initialized
  const existingConfig = await connection.getAccountInfo(configPda);
  if (existingConfig) {
    console.log('Bridge already initialized! Config data length:', existingConfig.data.length);
    console.log('Skipping initialization...');
  } else {
    // Step 1: Initialize the bridge
    console.log('Step 1: Initializing L2 Bridge...');
    const relayerPubkey = deployer.publicKey; // deployer = relayer
    
    try {
      const initIx = buildInitializeIx(deployer.publicKey, relayerPubkey);
      const initTx = new Transaction().add(initIx);
      const initSig = await sendAndConfirmTransaction(connection, initTx, [deployer]);
      console.log('  ✓ Bridge initialized:', initSig);
    } catch (e) {
      console.error('  ✗ Init failed:', e.message);
      if (e.logs) console.error('  Logs:', e.logs.join('\n'));
      return;
    }
  }
  
  // Step 2: Fund the reserve with Foundation MYTH
  const LAMPORTS_PER_MYTH = 1_000_000_000n;
  const FUND_AMOUNT = 100_000_000n * LAMPORTS_PER_MYTH; // 100M MYTH first batch
  
  const foundationBalance = await connection.getBalance(foundation.publicKey);
  const reserveBalance = await connection.getBalance(reservePda);
  
  console.log();
  console.log('Foundation balance:', (Number(foundationBalance) / 1e9).toFixed(4), 'MYTH');
  console.log('Reserve balance:   ', (Number(reserveBalance) / 1e9).toFixed(4), 'MYTH');
  
  if (reserveBalance > 0) {
    console.log('Reserve already funded! Skipping...');
  } else {
    console.log();
    console.log('Step 2: Funding bridge reserve with 100M MYTH...');
    
    if (BigInt(foundationBalance) < FUND_AMOUNT + 10000n) {
      console.error('  ✗ Foundation balance too low!');
      return;
    }
    
    try {
      const fundIx = buildFundReserveIx(foundation.publicKey, FUND_AMOUNT);
      const fundTx = new Transaction().add(fundIx);
      const fundSig = await sendAndConfirmTransaction(connection, fundTx, [foundation]);
      console.log('  ✓ Reserve funded:', fundSig);
    } catch (e) {
      console.error('  ✗ Fund failed:', e.message);
      if (e.logs) console.error('  Logs:', e.logs.join('\n'));
      return;
    }
  }
  
  // Verify
  const finalReserve = await connection.getBalance(reservePda);
  const finalFoundation = await connection.getBalance(foundation.publicKey);
  console.log();
  console.log('=== Final State ===');
  console.log('Reserve PDA balance: ', (Number(finalReserve) / 1e9).toFixed(4), 'MYTH');
  console.log('Foundation remaining:', (Number(finalFoundation) / 1e9).toFixed(4), 'MYTH');
  console.log();
  console.log('L2 Bridge is ready!');
}

main().catch(console.error);

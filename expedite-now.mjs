#!/usr/bin/env node
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  TOKEN_2022_PROGRAM_ID
} from '@solana/spl-token';
import fs from 'fs';

const RPC = 'https://api.mainnet-beta.solana.com';
const BRIDGE_PROGRAM = new PublicKey('oEQfREm4FQkaVeRoxJHkJLB1feHprrntY6eJuW2zbqQ');
const MYTH_MINT = new PublicKey('5UP2iL9DefXC3yovX9b4XG2EiCnyxuVo3S2F6ik5pump');

const WITHDRAW_AMOUNT = 9_999_999_999_800n; // 9,999,999.9998 MYTH (6 decimals) — matches L2 burn
const WITHDRAW_NONCE = 37n;
const RECIPIENT = new PublicKey('GaRmhD2zQVymx7cMosm9gcxkcg65muW1kr8uuW3tFRBv');
const RESTORE_CHALLENGE = 86400;

const CONFIG_SEED = Buffer.from('bridge_config');
const VAULT_SEED = Buffer.from('vault');
const WITHDRAWAL_SEED = Buffer.from('withdrawal');

const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('/mnt/data/mythic-l2/keys/deployer.json', 'utf8'))));
const sequencer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('/mnt/data/mythic-l2/keys/sequencer-identity.json', 'utf8'))));

const [configPDA] = PublicKey.findProgramAddressSync([CONFIG_SEED], BRIDGE_PROGRAM);
const [vaultPDA] = PublicKey.findProgramAddressSync([VAULT_SEED, MYTH_MINT.toBuffer()], BRIDGE_PROGRAM);
const nonceBytes = Buffer.alloc(8); nonceBytes.writeBigUInt64LE(WITHDRAW_NONCE);
const [withdrawalPDA] = PublicKey.findProgramAddressSync([WITHDRAWAL_SEED, nonceBytes], BRIDGE_PROGRAM);

const conn = new Connection(RPC, 'confirmed');

function updateConfigIx(period) {
  const buf = Buffer.alloc(11);
  buf.writeUInt8(6, 0); buf.writeUInt8(0, 1); buf.writeUInt8(1, 2);
  buf.writeBigInt64LE(BigInt(period), 3);
  return new TransactionInstruction({
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPDA, isSigner: false, isWritable: true },
    ],
    programId: BRIDGE_PROGRAM, data: buf,
  });
}

function initiateIx() {
  const buf = Buffer.alloc(1 + 32 + 8 + 32 + 32 + 8);
  let o = 0;
  buf.writeUInt8(3, o); o += 1;
  RECIPIENT.toBuffer().copy(buf, o); o += 32;
  buf.writeBigUInt64LE(WITHDRAW_AMOUNT, o); o += 8;
  MYTH_MINT.toBuffer().copy(buf, o); o += 32;
  o += 32; // merkle proof zeros
  buf.writeBigUInt64LE(WITHDRAW_NONCE, o);
  return new TransactionInstruction({
    keys: [
      { pubkey: sequencer.publicKey, isSigner: true, isWritable: false },
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: withdrawalPDA, isSigner: false, isWritable: true },
      { pubkey: configPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: BRIDGE_PROGRAM, data: buf,
  });
}

function finalizeIx(recipientATA) {
  const buf = Buffer.alloc(9);
  buf.writeUInt8(5, 0);
  buf.writeBigUInt64LE(WITHDRAW_NONCE, 1);
  return new TransactionInstruction({
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: withdrawalPDA, isSigner: false, isWritable: true },
      { pubkey: vaultPDA, isSigner: false, isWritable: true },
      { pubkey: recipientATA, isSigner: false, isWritable: true },
      { pubkey: MYTH_MINT, isSigner: false, isWritable: false },
      { pubkey: configPDA, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: BRIDGE_PROGRAM, data: buf,
  });
}

async function main() {
  console.log('Deployer:', deployer.publicKey.toBase58());
  console.log('Recipient:', RECIPIENT.toBase58());
  console.log('Amount:', (Number(WITHDRAW_AMOUNT) / 1e6).toFixed(4), 'MYTH');
  console.log('Nonce:', WITHDRAW_NONCE.toString());
  console.log('');

  // Step 1: Set challenge to 0
  console.log('Step 1: Setting challenge_period to 0...');
  const sig1 = await sendAndConfirmTransaction(conn, new Transaction().add(updateConfigIx(0)), [deployer]);
  console.log('  TX:', sig1);

  // Step 2: Ensure recipient ATA
  const recipientATA = getAssociatedTokenAddressSync(MYTH_MINT, RECIPIENT, false, TOKEN_2022_PROGRAM_ID);
  console.log('Step 2: Recipient ATA:', recipientATA.toBase58());
  const ataInfo = await conn.getAccountInfo(recipientATA);
  if (!ataInfo) {
    console.log('  Creating ATA...');
    const sig2 = await sendAndConfirmTransaction(conn, new Transaction().add(
      createAssociatedTokenAccountInstruction(deployer.publicKey, recipientATA, RECIPIENT, MYTH_MINT, TOKEN_2022_PROGRAM_ID)
    ), [deployer]);
    console.log('  TX:', sig2);
  } else {
    console.log('  ATA exists');
  }

  // Step 3: Initiate
  console.log('Step 3: Initiating withdrawal...');
  const sig3 = await sendAndConfirmTransaction(conn, new Transaction().add(initiateIx()), [sequencer, deployer]);
  console.log('  TX:', sig3);

  await new Promise(r => setTimeout(r, 2000));

  // Step 4: Finalize
  console.log('Step 4: Finalizing...');
  const sig4 = await sendAndConfirmTransaction(conn, new Transaction().add(finalizeIx(recipientATA)), [deployer]);
  console.log('  TX:', sig4);

  // Step 5: Restore
  console.log('Step 5: Restoring challenge to 86400...');
  const sig5 = await sendAndConfirmTransaction(conn, new Transaction().add(updateConfigIx(RESTORE_CHALLENGE)), [deployer]);
  console.log('  TX:', sig5);

  // Verify
  const ata = await conn.getAccountInfo(recipientATA);
  const bal = ata.data.readBigUInt64LE(64);
  console.log('\nRecipient MYTH balance:', (Number(bal) / 1e6).toFixed(2));
  console.log('DONE');
}

main().catch(async err => {
  console.error('ERROR:', err.message || err);
  try {
    console.log('Restoring challenge period...');
    await sendAndConfirmTransaction(conn, new Transaction().add(updateConfigIx(RESTORE_CHALLENGE)), [deployer]);
    console.log('Restored.');
  } catch (e) { console.error('Failed to restore:', e.message); }
  process.exit(1);
});

#!/usr/bin/env node
/**
 * RPOW2 Balance Checker
 * 
 * Usage:
 *   node check.js                  # Check all accounts from accounts.json
 *   node check.js --single         # Check single account from config.js
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.rpow2.com';

async function checkBalance(cookie, name) {
  const res = await fetch(`${API_BASE}/me`, {
    headers: { cookie: `rpow_session=${cookie}` },
  });

  if (res.status === 401) {
    return { name, error: 'Session expired' };
  }
  if (!res.ok) {
    return { name, error: `HTTP ${res.status}` };
  }

  const me = await res.json();
  return {
    name,
    email: me.email,
    balance: me.balance,
    minted: me.minted,
    sent: me.sent,
    received: me.received,
  };
}

async function main() {
  const singleMode = process.argv.includes('--single');

  let accounts = [];

  if (singleMode) {
    const config = require('./config.js');
    accounts = [{ name: 'default', cookie: config.SESSION_COOKIE }];
  } else {
    const accountsFile = path.join(__dirname, 'accounts.json');
    if (!fs.existsSync(accountsFile)) {
      // Fallback to single config
      const config = require('./config.js');
      accounts = [{ name: 'default', cookie: config.SESSION_COOKIE }];
    } else {
      accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    }
  }

  // Filter out placeholder cookies
  accounts = accounts.filter(a => a.cookie && !a.cookie.includes('PASTE'));

  if (accounts.length === 0) {
    console.log('❌ No valid accounts found. Set cookies in accounts.json or config.js');
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  💰 RPOW2 Balance Checker');
  console.log(`${'═'.repeat(60)}\n`);

  // Check all accounts in parallel
  const results = await Promise.all(
    accounts.map(a => checkBalance(a.cookie, a.name))
  );

  // Display table
  let totalBalance = 0;
  let totalMinted = 0;

  console.log('  ┌─────────────────┬──────────────────────────────┬─────────┬─────────┬──────┬──────────┐');
  console.log('  │ Account         │ Email                        │ Balance │ Minted  │ Sent │ Received │');
  console.log('  ├─────────────────┼──────────────────────────────┼─────────┼─────────┼──────┼──────────┤');

  for (const r of results) {
    if (r.error) {
      console.log(`  │ ${pad(r.name, 15)} │ ❌ ${pad(r.error, 26)} │    —    │    —    │  —   │    —     │`);
    } else {
      totalBalance += r.balance;
      totalMinted += r.minted;
      console.log(`  │ ${pad(r.name, 15)} │ ${pad(r.email, 28)} │ ${pad(String(r.balance), 7)} │ ${pad(String(r.minted), 7)} │ ${pad(String(r.sent), 4)} │ ${pad(String(r.received), 8)} │`);
    }
  }

  console.log('  └─────────────────┴──────────────────────────────┴─────────┴─────────┴──────┴──────────┘');

  if (results.length > 1) {
    console.log(`\n  📊 Total: ${totalBalance} RPOW (${totalMinted} minted across ${results.filter(r => !r.error).length} accounts)`);
  }

  console.log('');
}

function pad(str, len) {
  if (str.length > len) return str.slice(0, len - 1) + '…';
  return str.padEnd(len);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

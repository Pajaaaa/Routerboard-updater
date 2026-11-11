#!/usr/bin/env node
'use strict';
// lib/inspect.js regSignal: propad klouzavého průměru signal-strength se nesmí číst jako slabý signál (11.11.2026 Lhota7)
const assert = require('assert');
process.env.MTU_SECRET = process.env.MTU_SECRET || 'test-secret-1234567890';
process.env.MTU_PASSWORD = process.env.MTU_PASSWORD || 'test';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/mtu-regsig-');
const { regSignal } = require('../lib/inspect');
const rates = '-85dBm@6Mbps 10ms;-19dBm@9Mbps 14h20m11s740ms;-22dBm@12Mbps 14h20m10s530ms;-25dBm@54Mbps 14h20m7s810ms';
assert.strictEqual(regSignal('-85dBm@6Mbps', rates), -19, 'propad aktuálního čtení přebije měření na ostatních rychlostech');
assert.strictEqual(regSignal('-62dBm@HT20-7', ''), -62, 'bez strength-at-rates platí aktuální hodnota');
assert.strictEqual(regSignal('-80dBm@6Mbps', '-81dBm@6Mbps 0ms;-83dBm@9Mbps 2h'), -80, 'opravdu slabý klient zůstane slabý');
assert.strictEqual(regSignal('', ''), null, 'prázdné = neznámo');
assert.strictEqual(regSignal('-70', undefined), -70, 'holé číslo');
console.log('reg-signal OK');

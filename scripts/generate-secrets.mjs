#!/usr/bin/env node
// Prints a fresh value for the encryption key this server needs. Paste it into the Railway variables.
import { randomBytes } from 'node:crypto';
process.stdout.write(`TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}\n`);

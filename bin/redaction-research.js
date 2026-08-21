#!/usr/bin/env node

'use strict';

const { defaultCliDataDirectory } = require('../lib/app-paths.js');
const { version } = require('../package.json');

const HELP = `RedactionResearch ${version}

Lokale Web-App zum Erkennen und Prüfen unsicherer PDF-Schwärzungen.

Verwendung:
  RedactionResearch [Optionen]

Optionen:
  -p, --port <port>  Port des lokalen Webservers (Standard: 3003)
  -h, --help         Hilfe anzeigen
  -v, --version      Version anzeigen

Beispiele:
  RedactionResearch
  RedactionResearch --port 4000
  RedactionResearch --port=4000
`;

function readPort(args) {
    let port = null;

    for (let index = 0; index < args.length; index++) {
        const argument = args[index];

        if (argument === '--help' || argument === '-h') return { action: 'help' };
        if (argument === '--version' || argument === '-v') return { action: 'version' };

        if (argument === '--port' || argument === '-p') {
            if (port !== null) throw new Error('--port darf nur einmal angegeben werden.');
            port = args[++index];
            if (port === undefined) throw new Error(`Nach ${argument} fehlt der Port.`);
            continue;
        }

        if (argument.startsWith('--port=')) {
            if (port !== null) throw new Error('--port darf nur einmal angegeben werden.');
            port = argument.slice('--port='.length);
            continue;
        }

        throw new Error(`Unbekannte Option: ${argument}`);
    }

    if (port === null) return { action: 'start' };
    if (!/^\d+$/.test(port)) throw new Error('Der Port muss eine ganze Zahl zwischen 1 und 65535 sein.');

    const numericPort = Number(port);
    if (numericPort < 1 || numericPort > 65535) {
        throw new Error('Der Port muss eine ganze Zahl zwischen 1 und 65535 sein.');
    }

    return { action: 'start', port: numericPort };
}

function main() {
    let options;

    try {
        options = readPort(process.argv.slice(2));
    } catch (error) {
        console.error(`Fehler: ${error.message}\n`);
        console.error('Mit RedactionResearch --help wird die Hilfe angezeigt.');
        process.exitCode = 1;
        return;
    }

    if (options.action === 'help') {
        console.log(HELP);
        return;
    }

    if (options.action === 'version') {
        console.log(version);
        return;
    }

    if (options.port !== undefined) process.env.PORT = String(options.port);
    if (!process.env.REDACTION_RESEARCH_OUTPUT_DIR) {
        process.env.REDACTION_RESEARCH_OUTPUT_DIR = defaultCliDataDirectory();
    }

    require('../server.js').startServer();
}

if (require.main === module) main();

module.exports = { readPort };

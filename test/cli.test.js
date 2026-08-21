const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliFile = path.join(__dirname, '..', 'bin', 'redaction-research.js');

function runCli(...args) {
    return spawnSync(process.execPath, [cliFile, ...args], {
        encoding: 'utf8',
        timeout: 5_000,
    });
}

test('CLI documents its start command and port option', () => {
    const result = runCli('--help');

    assert.equal(result.status, 0);
    assert.match(result.stdout, /RedactionResearch --port 4000/);
    assert.equal(result.stderr, '');
});

test('CLI rejects invalid ports before starting the application', () => {
    for (const port of ['0', '65536', 'abc', '12.5']) {
        const result = runCli('--port', port);

        assert.equal(result.status, 1, port);
        assert.match(result.stderr, /zwischen 1 und 65535/, port);
    }
});

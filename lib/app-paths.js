const os = require('node:os');
const path = require('node:path');

function defaultCliDataDirectory({ platform = process.platform, environment = process.env, home = os.homedir() } = {}) {
    const pathApi = platform === 'win32' ? path.win32 : path.posix;

    if (platform === 'darwin') {
        return pathApi.join(home, 'Library', 'Application Support', 'redaction-research');
    }

    if (platform === 'win32') {
        return pathApi.join(environment.APPDATA || pathApi.join(home, 'AppData', 'Roaming'), 'redaction-research');
    }

    return pathApi.join(environment.XDG_DATA_HOME || pathApi.join(home, '.local', 'share'), 'redaction-research');
}

module.exports = { defaultCliDataDirectory };

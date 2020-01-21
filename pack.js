const fs = require('fs');
const path = require('path');

function escape(script) {
    return script.split('\\').join('\\\\').split('\'').join('\\\'');
}

module.exports.pack = function pack(scriptPath) {
    const scriptName = path.basename(scriptPath);
    const dirPath = path.dirname(scriptPath);
    const script = fs.readFileSync(scriptPath, { encoding: 'utf8' });
    let lines = script.split(/\r?\n/);
    lines = lines.map(line => {
        const m = line.match(/^from\s+\.\s+import\s+(\w+)\s*$/);
        if (!m) {
            return line;
        }
        return (
            `import sys, importlib.util\n`
            + `${m[1]} = importlib.util.module_from_spec(importlib.util.spec_from_loader(__name__${scriptName != '__init__.py' ? '.rsplit(\'.\', 1)[0]' : ''} + '.${m[1]}', loader=None))\n`
            + `exec('''${escape(pack(path.join(dirPath, m[1] + '.py')))}''', ${m[1]}.__dict__)\n`
            + `sys.modules[__name__${scriptName != '__init__.py' ? '.rsplit(\'.\', 1)[0]' : ''} + '.${m[1]}'] = ${m[1]}`
        );
    });
    return lines.join('\n');
}

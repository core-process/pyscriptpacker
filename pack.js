const fs = require('fs');
const path = require('path');

function escape(script) {
    return script.split('\\').join('\\\\').split('\'').join('\\\'');
}

function findLibrary(libraryName, isMainLibrary, libraryPaths) {
    for (const libraryBasePath of libraryPaths) {
        // construct library path
        const libraryPath = path.join(libraryBasePath, libraryName);
        // check if library exists
        if (
            fs.existsSync(path.join(libraryPath, 'pack.list'))
            && (!isMainLibrary || fs.existsSync(path.join(libraryPath, '__main__.py')))
        ) {
            return libraryPath;
        }
    }

    throw new Error(`could not find ${packEntry} in library paths (pack.list available?)`);
}

function packModules(dialect, libraryPath, libraryName, libraryPaths) {

    // read pack list
    const packList = fs
        .readFileSync(path.join(libraryPath, 'pack.list'), { encoding: 'utf8' })
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line);

    // pack modules
    const modules = new Map();

    for (const packEntry of packList) {

        // handle library reference
        if (!packEntry.startsWith('.')) {
            // pack library
            packModules(dialect, findLibrary(packEntry, false, libraryPaths), packEntry, libraryPaths).forEach((moduleCode, moduleName) => {
                if (!modules.has(moduleName)) {
                    modules.set(moduleName, moduleCode);
                } else {
                    if (modules.get(moduleName).spec !== moduleCode.spec
                        || modules.get(moduleName).link !== moduleCode.link
                        || modules.get(moduleName).loader !== moduleCode.loader
                    ) {
                        throw new Error(`two different scripts for ${moduleName} detected`);
                    }
                }
            });
        }
        // handle local file reference
        else {
            // lookup item path
            const moduleBasePath = path.join(libraryPath, ...packEntry.substr(1).split('.'));
            const modulePaths = [moduleBasePath + '.py', path.join(moduleBasePath, '__init__.py')];
            const modulePath = modulePaths.filter(modulePath => fs.existsSync(modulePath)).pop();

            if (!modulePath) {
                throw new Error(`could not find ${packEntry} in ${libraryName}`);
            }

            const isPackage = modulePath == modulePaths[1];

            // build module name
            const moduleName =
                (libraryName.endsWith('.') ? libraryName.substr(0, libraryName.length - 1) : libraryName)
                + (packEntry.endsWith('.') ? packEntry.substr(0, packEntry.length - 1) : packEntry);
            const moduleNameCode = JSON.stringify(moduleName);

            // build parent module name
            let hasParent = false;
            let moduleLocalName = null;
            let moduleParentName = null;

            if (moduleName.indexOf('.') !== -1) {
                hasParent = true;
                const parts = moduleName.split('.');
                moduleLocalName = parts.pop();
                moduleParentName = parts.join('.');
            }

            // build package name
            const packageName = isPackage ? moduleName : moduleName.substring(0, moduleName.lastIndexOf('.'));

            // pack
            let moduleCode = null;

            let linkCode = '';
            if (hasParent) {
                linkCode = `setattr(sys.modules[${JSON.stringify(moduleParentName)}], ${JSON.stringify(moduleLocalName)}, sys.modules[${moduleNameCode}])`;
            }

            if (dialect == '2.7') {
                moduleCode = {
                    spec:
                        `sys.modules[${moduleNameCode}] = imp.new_module(${moduleNameCode})\nsys.modules[${moduleNameCode}].__name__ = ${moduleNameCode}`
                        + `\nsys.modules[${moduleNameCode}].__package__ = ${JSON.stringify(packageName)}`
                        + (isPackage ? `\nsys.modules[${moduleNameCode}].__path__ = []` : ''),
                    link: linkCode,
                    loader: `exec '''${escape(fs.readFileSync(modulePath, { encoding: 'utf8' }))}''' in sys.modules[${moduleNameCode}].__dict__`
                };
            } else if (dialect == '3.5') {
                moduleCode = {
                    spec: `sys.modules[${moduleNameCode}] = importlib.util.module_from_spec(importlib.util.spec_from_loader(${moduleNameCode}, loader=None, is_package=${isPackage ? 'True' : 'None'}))`,
                    link: linkCode,
                    loader: `exec('''${escape(fs.readFileSync(modulePath, { encoding: 'utf8' }))}''', sys.modules[${moduleNameCode}].__dict__)`
                };
            } else {
                throw new Error('unknown dialect');
            }

            modules.set(moduleName, moduleCode);
        }
    }

    return modules;
}

module.exports.pack = function pack(dialect, packageName, libraryPaths) {

    // read module file and pack list
    const libraryPath = findLibrary(packageName, true, libraryPaths)
    const mainScript = fs.readFileSync(path.join(libraryPath, '__main__.py'), { encoding: 'utf8' }).split(/\r?\n/);

    const modules = packModules(dialect, libraryPath, packageName, libraryPaths)

    // generate unique isolation token
    const tokenCode = 'import uuid\n__pack_isolation_token = "packed_" + uuid.uuid4().hex + "_"';
    mainScript.splice(0, 0, tokenCode);

    // insert packed modules
    let importCode = null;
    if (dialect == '2.7') {
        importCode = 'import sys, imp';
    } else if (dialect == '3.5') {
        importCode = 'import sys, importlib.util';
    } else {
        throw new Error('unknown dialect');
    }

    let insertIdx = mainScript.findIndex(line => line.match(/^import\s+/));
    if (insertIdx === -1) {
        insertIdx = 0;
    }

    mainScript.splice(
        insertIdx, 0,
        `\n${importCode}\n\n`
        + [...modules.values()].map(mod => mod.spec).join('\n') + `\n\n`
        + [...modules.values()].map(mod => mod.link).join('\n') + `\n\n`
        + [...modules.values()].map(mod => mod.loader).join('\n\n') + `\n`
    );

    // assemble result
    return mainScript.join('\n');
}

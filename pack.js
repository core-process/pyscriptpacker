const fs = require('fs');
const path = require('path');

function escape(script) {
    return script.split('\\').join('\\\\').split('\'').join('\\\'');
}

function findPackage(packageName, isMainPackage, libraryPaths) {
    for (const libraryPath of libraryPaths) {
        // construct paths of reference module
        const packagePath = path.join(libraryPath, packageName);
        const packListPath = path.join(packagePath, 'pack.list');
        const mainScriptPath = path.join(packagePath, '__main__.py');
        // check if module exists
        if (fs.existsSync(packListPath) && (!isMainPackage || fs.existsSync(mainScriptPath))) {
            return packagePath;
        }
    }
    return null;
}

function readPackList(refPackListPath) {
    return fs
        .readFileSync(refPackListPath, { encoding: 'utf8' })
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line);
}

function packModules(dialect, packagePath, libName, packList, libraryPaths) {

    const modules = new Map();

    for (const entry of packList) {
        // handle library reference
        if (!entry.startsWith('.')) {
            // pack library
            const refPackagePath = findPackage(entry, false, libraryPaths);
            if (refPackagePath) {
                const refPackList = readPackList(path.join(refPackagePath, 'pack.list'));
                packModules(dialect, refPackagePath, entry, refPackList, libraryPaths).forEach((v, k) => {
                    if (!modules.has(k)) {
                        modules.set(k, v);
                    } else {
                        if (modules.get(k).spec !== v.spec || modules.get(k).link !== v.link || modules.get(k).loader !== v.loader) {
                            throw new Error(`two different scripts for ${k} detected`);
                        }
                    }
                });
            }
            // if we reach here, we could not find the reference module
            else {
                throw new Error(`could not find ${entry} in library paths (pack.list available?)`);
            }
        }
        // handle local file reference
        else {
            // lookup item path
            const itemPathBase = path.join(packagePath, ...entry.substr(1).split('.'));
            const itemPaths = [itemPathBase + '.py', path.join(itemPathBase, '__init__.py')];
            const itemPath = itemPaths.filter(itemPath => fs.existsSync(itemPath)).pop();

            if (!itemPath) {
                throw new Error(`could not find ${entry} in module`);
            }

            const isPackage = itemPath == itemPaths[1];

            // build qualified name
            const moduleName =
                (libName.endsWith('.') ? libName.substr(0, libName.length - 1) : libName)
                + (entry.endsWith('.') ? entry.substr(0, entry.length - 1) : entry);
            const moduleNameCode = JSON.stringify(moduleName);

            // build package name
            const packageName = isPackage ? moduleName : moduleName.substring(0, moduleName.lastIndexOf('.'));

            // build parent module name
            let parentModuleName = null;
            let localModuleName = null;

            if (moduleName.indexOf('.') !== -1) {
                const parts = moduleName.split('.');
                localModuleName = parts.pop();
                parentModuleName = parts.join('.');
            }

            // pack
            let moduleCode = null;

            let linkCode = '';
            if (parentModuleName && localModuleName) {
                linkCode = `setattr(sys.modules[${JSON.stringify(parentModuleName)}], ${JSON.stringify(localModuleName)}, sys.modules[${moduleNameCode}])`;
            }

            if (dialect == '2.7') {
                moduleCode = {
                    spec:
                        `sys.modules[${moduleNameCode}] = imp.new_module(${moduleNameCode})\nsys.modules[${moduleNameCode}].__name__ = ${moduleNameCode}`
                        + `\nsys.modules[${moduleNameCode}].__package__ = ${JSON.stringify(packageName)}`
                        + (isPackage ? `\nsys.modules[${moduleNameCode}].__path__ = []` : ''),
                    link: linkCode,
                    loader: `exec '''${escape(fs.readFileSync(itemPath, { encoding: 'utf8' }))}''' in sys.modules[${moduleNameCode}].__dict__`
                };
            } else if (dialect == '3.5') {
                moduleCode = {
                    spec: `sys.modules[${moduleNameCode}] = importlib.util.module_from_spec(importlib.util.spec_from_loader(${moduleNameCode}, loader=None, is_package=${isPackage ? 'True' : 'None'}))`,
                    link: linkCode,
                    loader: `exec('''${escape(fs.readFileSync(itemPath, { encoding: 'utf8' }))}''', sys.modules[${moduleNameCode}].__dict__)`
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
    const packagePath = findPackage(packageName, true, libraryPaths)
    const mainScript = fs.readFileSync(path.join(packagePath, '__main__.py'), { encoding: 'utf8' }).split(/\r?\n/);
    const packList = readPackList(path.join(packagePath, 'pack.list'));

    const modules = packModules(dialect, packagePath, packageName, packList, libraryPaths)

    // find first import line
    let insertIdx = mainScript.findIndex(line => line.match(/^import\s+/));
    if (insertIdx === -1) {
        insertIdx = 0;
    }

    // insert packed modules and assemble result
    let importCode = null;
    if (dialect == '2.7') {
        importCode = 'import sys, imp';
    } else if (dialect == '3.5') {
        importCode = 'import sys, importlib.util';
    } else {
        throw new Error('unknown dialect');
    }

    mainScript.splice(
        insertIdx, 0,
        `\n${importCode}\n\n`
        + [...modules.values()].map(entry => entry.spec).join('\n') + `\n\n`
        + [...modules.values()].map(entry => entry.link).join('\n') + `\n\n`
        + [...modules.values()].map(entry => entry.loader).join('\n\n') + `\n`
    );
    return mainScript.join('\n');
}

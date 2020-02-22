
import { DIAGNOSTICS_NAME_SUFFIX } from '..';
import { lang as langOriginal } from '../cpp17';

const lang = Object.assign({}, langOriginal);

lang.name += DIAGNOSTICS_NAME_SUFFIX;
lang.compile = (sourcePath, outputDirectory) => {
    let res = langOriginal.compile(sourcePath, outputDirectory);
    res.parameters = res.parameters.filter(a => a !== "-O2").concat("-ggdb", "-fsanitize=undefined");
    return res;
};

export { lang };

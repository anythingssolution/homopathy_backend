const AppError = require('./AppError');

const buildMissingDependencyError = (packageName, cause) => {
    const error = new AppError(
        `Missing required package "${packageName}". Run npm install to enable this feature.`,
        500,
        { missing_package: packageName }
    );

    error.originalError = cause;
    return error;
};

const requireDependency = (packageName) => {
    try {
        return require(packageName);
    } catch (error) {
        if (error?.code === 'MODULE_NOT_FOUND' && error?.message?.includes(`'${packageName}'`)) {
            throw buildMissingDependencyError(packageName, error);
        }

        throw error;
    }
};

const importDependency = async (packageName) => {
    try {
        return await import(packageName);
    } catch (error) {
        if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
            throw buildMissingDependencyError(packageName, error);
        }

        throw error;
    }
};

module.exports = {
    requireDependency,
    importDependency,
};

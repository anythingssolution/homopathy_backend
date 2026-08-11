const { randomInt } = require('crypto');

const generateOtp = ({
    nodeEnv,
    defaultOtp,
    useDefaultInProduction = false,
    randomIntFn = randomInt,
}) => {
    const shouldUseDefaultOtp = nodeEnv !== 'production' || useDefaultInProduction === true;

    if (shouldUseDefaultOtp) {
        return String(defaultOtp);
    }

    return String(randomIntFn(100000, 1000000));
};

module.exports = {
    generateOtp,
};

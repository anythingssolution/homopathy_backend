const AppError = require('./AppError');

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const normalizeDateOfBirth = (value, { fieldName = 'date_of_birth' } = {}) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;

    const normalized = String(value).trim();
    if (!DATE_ONLY_PATTERN.test(normalized)) {
        throw new AppError(`${fieldName} must be in YYYY-MM-DD format`, 400);
    }

    const parsed = new Date(`${normalized}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
        throw new AppError(`${fieldName} must be a valid date`, 400);
    }

    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    if (parsed > todayUtc) {
        throw new AppError(`${fieldName} cannot be a future date`, 400);
    }

    const earliestAllowed = new Date(Date.UTC(todayUtc.getUTCFullYear() - 120, todayUtc.getUTCMonth(), todayUtc.getUTCDate()));
    if (parsed < earliestAllowed) {
        throw new AppError(`${fieldName} cannot be more than 120 years old`, 400);
    }

    return normalized;
};

const calculateAgeYearsFromDateOfBirth = (dateOfBirth) => {
    if (!dateOfBirth) return null;
    const birth = new Date(`${String(dateOfBirth).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(birth.getTime())) return null;

    const today = new Date();
    let years = today.getUTCFullYear() - birth.getUTCFullYear();
    const monthDiff = today.getUTCMonth() - birth.getUTCMonth();
    const dayDiff = today.getUTCDate() - birth.getUTCDate();

    if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
        years -= 1;
    }

    return Math.max(0, years);
};

const normalizeAgePayload = ({
    age,
    dateOfBirth,
    partial = false,
    ageFieldName = 'age',
    dateFieldName = 'date_of_birth',
} = {}) => {
    const normalizedDateOfBirth = normalizeDateOfBirth(dateOfBirth, { fieldName: dateFieldName });
    const hasAge = age !== undefined && age !== null && age !== '';
    const hasDob = normalizedDateOfBirth !== undefined && normalizedDateOfBirth !== null;

    if (!partial && !hasAge && !hasDob) {
        throw new AppError(`${ageFieldName} or ${dateFieldName} is required`, 400);
    }

    if (hasDob) {
        return {
            age: calculateAgeYearsFromDateOfBirth(normalizedDateOfBirth),
            date_of_birth: normalizedDateOfBirth,
        };
    }

    if (!hasAge) {
        return {
            age: undefined,
            date_of_birth: normalizedDateOfBirth,
        };
    }

    const parsedAge = Number(age);
    if (!Number.isInteger(parsedAge) || parsedAge < 1 || parsedAge > 120) {
        throw new AppError(`${ageFieldName} must be a valid number between 1 and 120`, 400);
    }

    return {
        age: parsedAge,
        date_of_birth: normalizedDateOfBirth,
    };
};

const buildAgeDisplaySql = (dateOfBirthExpression, ageExpression) => `
    CASE
        WHEN ${dateOfBirthExpression} IS NOT NULL THEN
            CASE
                WHEN TIMESTAMPDIFF(YEAR, ${dateOfBirthExpression}, CURDATE()) >= 1
                    THEN CONCAT(TIMESTAMPDIFF(YEAR, ${dateOfBirthExpression}, CURDATE()), ' Y')
                WHEN TIMESTAMPDIFF(MONTH, ${dateOfBirthExpression}, CURDATE()) >= 1
                    THEN CONCAT(TIMESTAMPDIFF(MONTH, ${dateOfBirthExpression}, CURDATE()), ' Months')
                ELSE CONCAT(GREATEST(DATEDIFF(CURDATE(), ${dateOfBirthExpression}), 0), ' Days')
            END
        WHEN ${ageExpression} IS NOT NULL THEN CONCAT(${ageExpression}, ' Y')
        ELSE NULL
    END
`;

module.exports = {
    buildAgeDisplaySql,
    calculateAgeYearsFromDateOfBirth,
    normalizeAgePayload,
    normalizeDateOfBirth,
};

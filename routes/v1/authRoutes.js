const express = require('express');
const {
    requestRegistrationOtp,
    verifyRegistrationOtp,
    registerUser,
    login,
    requestLoginOtp,
    verifyLoginOtp,
    getCurrentPatient,
    listSelectableBranches,
    selectCurrentBranch,
    updateCurrentPatientProfile,
    requestForgotPasswordOtp,
    verifyForgotPasswordOtp,
    resetForgotPassword,
    refreshToken,
    logout,
} = require('../../controllers/v1/authController');
const { authenticate } = require('../../middleware/authMiddleware');
const { authRateLimiter, otpRateLimiter } = require('../../middleware/rateLimitMiddleware');

const router = express.Router();

router.post('/register/otp/request', otpRateLimiter, requestRegistrationOtp);
router.post('/register/otp/verify', authRateLimiter, verifyRegistrationOtp);
router.post('/register', registerUser);

// Password login (primary + explicit alias)
router.post('/login', authRateLimiter, login);
router.post('/login/password', authRateLimiter, login);

// OTP login
router.post('/login/otp/request', otpRateLimiter, requestLoginOtp);
router.post('/login/otp/verify', authRateLimiter, verifyLoginOtp);

// Token lifecycle
router.post('/token/refresh', authRateLimiter, refreshToken);

// Forgot password
router.post('/password/forgot/request', otpRateLimiter, requestForgotPasswordOtp);
router.post('/password/forgot/verify', authRateLimiter, verifyForgotPasswordOtp);
router.post('/password/forgot/reset', authRateLimiter, resetForgotPassword);

router.get('/me', authenticate, getCurrentPatient);
router.get('/branches', authenticate, listSelectableBranches);
router.put('/selected-branch', authenticate, selectCurrentBranch);
router.patch('/selected-branch', authenticate, selectCurrentBranch);
router.put('/me', authenticate, updateCurrentPatientProfile);
router.patch('/me', authenticate, updateCurrentPatientProfile);
router.post('/logout', authenticate, logout);

module.exports = router;

const db = require('../database/db');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) {
        // Real-time verification that user is still active in DB
        const user = db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').get(req.session.user.id);
        if (!user || user.is_active === 0) {
            req.session.destroy(() => {});
            if (req.xhr || req.headers.accept?.includes('json') || req.path.startsWith('/api/')) {
                return res.status(403).json({ status: false, message: 'Akun Anda telah dinonaktifkan oleh Administrator.' });
            }
            return res.redirect('/login?error=' + encodeURIComponent('Akun Anda telah dinonaktifkan oleh Administrator.'));
        }

        req.session.user.role = user.role;
        res.locals.user = user;
        return next();
    }

    if (req.xhr || req.headers.accept?.includes('json') || req.path.startsWith('/api/')) {
        return res.status(401).json({ status: false, message: 'Authentication required' });
    }
    return res.redirect('/login');
}

function requireAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    if (req.xhr || req.headers.accept?.includes('json') || req.path.startsWith('/api/')) {
        return res.status(403).json({ status: false, message: 'Akses khusus Administrator.' });
    }
    return res.redirect('/devices');
}

function requireApiKey(req, res, next) {
    // Also allow authenticated dashboard sessions to call API without passing API key explicitly
    if (req.session && req.session.user) {
        req.apiKey = { id: null, name: `${req.session.user.username} (${req.session.user.role || 'user'})` };
        return next();
    }

    const key = req.headers['x-api-key'] || 
                req.body?.key || 
                req.body?.apiKey || 
                req.query?.key || 
                req.query?.apiKey || 
                (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') 
                    ? req.headers.authorization.split(' ')[1] 
                    : null);

    if (!key) {
        return res.status(401).json({ 
            status: false, 
            message: 'API Key is missing. Provide via "key" parameter in request body, X-API-Key header, or Bearer token.' 
        });
    }

    const keyRecord = db.prepare('SELECT * FROM api_keys WHERE key = ? AND is_active = 1').get(key);
    if (!keyRecord) {
        return res.status(403).json({ 
            status: false, 
            message: 'Invalid or deactivated API Key.' 
        });
    }

    req.apiKey = keyRecord;
    next();
}

module.exports = {
    requireAuth,
    requireAdmin,
    requireApiKey
};

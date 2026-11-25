import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const trustProxy = Number(process.env.TRUST_PROXY);

export default {
    node_env: process.env.NODE_ENV,
    port: process.env.PORT,
    db_url: process.env.MONGO_URL,
    bcrypt_salt_round: process.env.BCRYPT_SALT,
    default_password: process.env.DEFAULT_PASS,
    jwt_access_token: process.env.JWT_SECRET,
    jwt_access_token_exp: process.env.JWT_SECRET_EXP,
    jwt_refresh_token: process.env.JWT_REFRESH_SECRET,
    jwt_refresh_token_exp: process.env.JWT_REFRESH_SECRET_EXP,
    smtp_user: process.env.SMTP_USER,
    smtp_pass: process.env.SMTP_PASS,
    reset_ui_link: process.env.RESET_UI_LINK,
    super_admin_pass: process.env.SUPER_ADMIN_PASS,
    cloudinary_url: process.env.CLOUDINARY_URL,
    cloudinary_name: process.env.CLOUDINARY_NAME || "delete",
    cloudinary_key: process.env.CLOUDINARY_KEY,
    cloudinary_secret: process.env.CLOUDINARY_SECRET,
    //browser origins; an origin never ends with a slash
    client_origins: (process.env.CLIENT_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    app_timezone: process.env.APP_TIMEZONE || 'Asia/Dhaka',
    jobs_enabled: process.env.JOBS_ENABLED === 'true',
    //number of proxies in front of the server
    trust_proxy: Number.isInteger(trustProxy) && trustProxy >= 0 ? trustProxy : 0,
};
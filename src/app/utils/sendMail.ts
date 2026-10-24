import nodemailer from 'nodemailer'
import config from '../config/index.js';
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: config.node_env === 'production', // use STARTTLS (upgrade connection to TLS after connecting)
    auth: {
        user: config.smtp_user,
        pass: config.smtp_pass,
    },
});
const sendPassResetMail = async (to: string, html: string) => {
    await transporter.sendMail({
        from: config.smtp_user || '"Example Team" <team@example.com>', // sender address
        to, // list of recipients
        subject: "Change your password within 10 minutes!", // subject line
        text: "Use the link in the email body to reset your password. The link is valid for 10 minutes.", // plain text body
        html, // HTML body
    });
}

const sendVerificationOtpMail = async (to: string, html: string) => {
    await transporter.sendMail({
        from: config.smtp_user || '"Example Team" <team@example.com>',
        to,
        subject: "Your email verification code",
        text: "Use the 6-digit code in the email body to verify your email. The code is valid for 2 minutes.",
        html,
    });
}

export const sendMails = {
    sendPassResetMail,
    sendVerificationOtpMail,
}
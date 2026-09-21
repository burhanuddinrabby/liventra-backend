import nodemailer from 'nodemailer'
import config from '../config/index.js';

export const sendMail = async (to: string, html: string) => {
    const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: config.node_env === 'production', // use STARTTLS (upgrade connection to TLS after connecting)
        auth: {
            user: config.smtp_user,
            pass: config.smtp_pass,
        },
    });

    await transporter.sendMail({
        from: config.smtp_user || '"Example Team" <team@example.com>', // sender address
        to, // list of recipients
        subject: "Change your password within 10 minutes!", // subject line
        text: "Hello bhaiyeee?", // plain text body
        html, // HTML body
    });
}

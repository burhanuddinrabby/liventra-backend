import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import fs from 'fs/promises'
import config from '../config/index.js';

// Configuration
const cloudinaryConfig = {
    //need edit*3
    cloud_name: config.cloudinary_name || '',
    api_key: config.cloudinary_key || '',
    api_secret: config.cloudinary_secret || '' // Click 'View API Keys' above to copy your API secret
};

cloudinary.config(cloudinaryConfig);

export const uploadImageToCloudinary = async (imgName: string, path: string) => {
    const uploadResult = await cloudinary.uploader.upload(path, { public_id: imgName });
    await fs.unlink(path);
    return uploadResult;

    // Optimize delivery by resizing and applying auto-format and auto-quality
    // const optimizeUrl = cloudinary.url('shoes', {
    //     fetch_format: 'auto',
    //     quality: 'auto'
    // });

    // console.log(optimizeUrl);

    // Transform the image: auto-crop to square aspect_ratio
    // const autoCropUrl = cloudinary.url('shoes', {
    //     crop: 'auto',
    //     gravity: 'auto',
    //     width: 500,
    //     height: 500,
    // });

    // console.log(autoCropUrl);
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, process.cwd() + '/uploads')
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
        cb(null, file.fieldname + '-' + uniqueSuffix)
    }
})

export const upload = multer({ storage: storage })
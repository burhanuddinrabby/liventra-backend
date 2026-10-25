import { FarmModel } from "./farm.model.js";

const lastFarmId = async () => {
    const lastFarm = await FarmModel.find(
        {
        },
        {
            farmId: 1,
            _id: 0
        }
    ).sort({
        createdAt: -1
    }).lean();
    //263-12-0001
    const lastDigits: string = lastFarm[0]?.farmId?.split('-')[1] || '00000';
    return lastDigits;
};

export const generateFarmId = async (): Promise<string> => {
    const currentId = await lastFarmId();
    let incrementId = (Number(currentId) + 1).toString().padStart(5, '0');
    incrementId = `FARM-${incrementId}`
    return incrementId;
}
import type { Request, Response } from "express";
import status from "http-status";
import catchAsync from "../../utils/catchAsync.js";
import sendResponse from "../../utils/sendResponse.js";
import { FarmMemberServices } from "./farmMember.service.js";

const createMember = catchAsync(async (req: Request, res: Response) => {
  const member = await FarmMemberServices.createMember(
    req.params.farmId as string,
    req.user.userId,
    req.body,
  );
  sendResponse(res, {
    statusCode: status.CREATED,
    success: true,
    message: "Farm member added successfully!",
    data: member,
  });
});

const getFarmMembers = catchAsync(async (req: Request, res: Response) => {
  const { meta, members } = await FarmMemberServices.getFarmMembers(
    req.params.farmId as string,
    req.user.userId,
    req.query as Record<string, unknown>,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Farm members retrieved successfully!",
    meta,
    data: members,
  });
});

const getMemberById = catchAsync(async (req: Request, res: Response) => {
  const member = await FarmMemberServices.getMemberById(
    req.params.farmId as string,
    req.user.userId,
    req.params.memberId as string,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Farm member retrieved successfully!",
    data: member,
  });
});

const updateMember = catchAsync(async (req: Request, res: Response) => {
  const member = await FarmMemberServices.updateMember(
    req.params.farmId as string,
    req.user.userId,
    req.params.memberId as string,
    req.body,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Farm member updated successfully!",
    data: member,
  });
});

const toggleMemberActive = catchAsync(async (req: Request, res: Response) => {
  const member = await FarmMemberServices.toggleMemberActive(
    req.params.farmId as string,
    req.user.userId,
    req.params.memberId as string,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Farm member status updated successfully!",
    data: member,
  });
});

const deleteMember = catchAsync(async (req: Request, res: Response) => {
  const member = await FarmMemberServices.deleteMember(
    req.params.farmId as string,
    req.user.userId,
    req.params.memberId as string,
  );
  sendResponse(res, {
    statusCode: status.OK,
    success: true,
    message: "Farm member removed successfully!",
    data: member,
  });
});

export const FarmMemberController = {
  createMember,
  getFarmMembers,
  getMemberById,
  updateMember,
  toggleMemberActive,
  deleteMember,
};

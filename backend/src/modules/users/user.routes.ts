import { Router } from 'express';

import {
  authenticateRequest,
  requirePasswordChanged,
  requireUsersManage,
  requireUsersRead,
} from '../../middleware/auth.middleware.js';

import {
  createUser,
  disableUser,
  enableUser,
  getUser,
  listUsers,
  resetUserPassword,
  updateUser,
} from './user.controller.js';

const userRouter = Router();

userRouter.use(authenticateRequest);
userRouter.use(requirePasswordChanged);

userRouter.get('/', requireUsersRead, listUsers);
userRouter.post('/', requireUsersManage, createUser);
userRouter.get('/:userId', requireUsersRead, getUser);
userRouter.patch('/:userId', requireUsersManage, updateUser);
userRouter.patch('/:userId/disable', requireUsersManage, disableUser);
userRouter.patch('/:userId/enable', requireUsersManage, enableUser);
userRouter.patch('/:userId/reset-password', requireUsersManage, resetUserPassword);

export default userRouter;

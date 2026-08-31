import { Router } from 'express';

import { requireConversationsRead } from '../../middleware/auth.middleware.js';

import { createNote, deleteNote, listNotes } from './note.controller.js';

const noteRouter = Router({ mergeParams: true });

noteRouter.get('/', requireConversationsRead, listNotes);
noteRouter.post('/', requireConversationsRead, createNote);
noteRouter.delete('/:noteId', requireConversationsRead, deleteNote);

export default noteRouter;

/**
 * Generates fixtures for owner-reminder-command from the compiled Node module.
 *
 * Run from crm-api/:
 *   node tools/make_owner_reminder_command_fixtures.mjs
 */

process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '5001';
process.env.FRONTEND_ORIGIN ??= 'http://localhost:5173';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/fixture-generator-never-connects';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET ??= 'fixture-generator-placeholder-not-a-real-secret';
process.env.JWT_REFRESH_SECRET ??= 'fixture-generator-placeholder-not-a-real-secret';
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.WHATSAPP_BUSINESS_TIMEZONE = 'Asia/Kolkata';

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/followups/owner-reminder-command.service.js'),
).href;

const { createOwnerReminderCommandService } = await import(MODULE);

const NOW = new Date('2026-10-11T06:30:00.000Z'); // 12:00 IST Sunday

const LOOKS_LIKE_CASES = [
  'Remind me at 5 PM to call Rahul',
  'Set an alarm in 30 minutes to finish the report',
  'Set alarm for 6 PM',
  'Wake me at 7 AM',
  'What reminders do I have today?',
  'my reminders',
  'list reminders',
  'show reminders',
  'reminders do i have',
  'reminders today',
  'Cancel my reminder to call Rahul',
  'delete reminder',
  'remove reminder',
  'drop reminder',
  'Move my campaign reminder to 7 PM',
  'reschedule reminder to tomorrow',
  'shift reminder till 5pm',
  'push reminder until tomorrow',
  'A7 1',
  '1',
  'VX12 collected',
  'what did rahul say about the december date',
  'tell him we are available on the 15th',
  '',
  'remind',
  'just a reminder',
  'please wake me up',
  'reminder please',
];

const mockTasks = [
  { _id: 'task-a', title: 'call Rahul', note: null, dueAt: new Date('2026-10-11T11:30:00.000Z'), timezone: 'Asia/Kolkata', conversationId: 'conv-1' },
  { _id: 'task-b', title: 'review the campaign', note: null, dueAt: new Date('2026-10-12T04:30:00.000Z'), timezone: 'Asia/Kolkata', conversationId: null },
];

const createService = (tasks = mockTasks) => {
  let createdTask = null;
  let updatedTask = null;
  let rescheduledTask = null;
  let notified = [];

  const svc = createOwnerReminderCommandService({
    getOwnerActor: async () => ({ actor: { _id: 'owner-user-1' }, permissions: [] }),
    createFollowUpTask: async (params) => {
      createdTask = { _id: 'task-new', ...params };
      return createdTask;
    },
    findPendingTasksByUser: async () => tasks,
    rescheduleReminder: async (params) => {
      rescheduledTask = params;
      return null;
    },
    updateTaskStatus: async (params) => {
      updatedTask = params;
      return null;
    },
    notifyOwner: async (params) => {
      notified.push(params);
      return { providerMessageId: 'wamid' };
    },
    now: () => NOW,
  });

  return { svc, getCalls: () => ({ createdTask, updatedTask, rescheduledTask, notified }) };
};

const COMMAND_CASES = [
  'Remind me at 5 PM to call Rahul',
  'Set an alarm in 30 minutes to finish the report',
  'Set an alarm for 6 PM',
  'Remind me tomorrow at 10 AM to review the campaign',
  'Remind me tomorrow',
  'Remind me at 5',
  'Remind me in the evening to call the client',
  'Remind me every day at 9 AM to review new leads',
  'What reminders do I have today?',
  'Cancel my reminder to call Rahul',
  'cancel my reminder',
  'Move my campaign reminder to 7 PM',
  'move my campaign reminder',
  'A7 1',
  'VX12 collected',
];

const main = async () => {
  const dummy = createService().svc;
  const looksLikeResults = LOOKS_LIKE_CASES.map(text => ({
    input: text,
    looksLike: dummy.looksLikeReminderCommand(text),
  }));

  const commandResults = [];
  for (const text of COMMAND_CASES) {
    const { svc, getCalls } = createService();
    const result = await svc.handleOwnerReminderCommand({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      text,
      messageId: 'msg-1',
    });
    commandResults.push({
      input: text,
      result,
      calls: getCalls(),
    });
  }

  const out = {
    now: NOW.toISOString(),
    looksLike: looksLikeResults,
    commands: commandResults,
  };

  const target = path.resolve(process.cwd(), 'tests/fixtures/owner_reminder_command.json');
  writeFileSync(target, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`Wrote ${commandResults.length} command cases and ${looksLikeResults.length} looksLike cases to ${target}`);
};

main();


# iOS 26 UI update: how to pull, check and ship it

This branch restyles the frontend in Apple's iOS 26 / iPadOS 26 look (Liquid Glass) and tunes it
for phones, where most of the users are. **Only the frontend changed.**

- Branch: `ui/ios26`
- Repo: <https://github.com/DheerajKumarRana/Meta-lead-assistance>
- Built on: your `main` at `2d94338` ("show the AI-owner WhatsApp exchange in the Inbox"),
  so it applies on top of your latest work with no conflicts.

## What is and isn't touched

| Area | Changed? |
|---|---|
| `frontend/` (26 files: 25 edited, 1 new) | Yes, styling and layout only |
| `backend/`, `crm-api/`, `ai-brain-service/`, `ops/` | **No** |
| API calls, data, permissions, feature flags, `.env` | **No** |
| `package.json` / dependencies | **No**, so there is nothing new to `npm install` |

Every existing frontend test passes unchanged (66 files, 718 tests), and `tsc --noEmit` is clean.

## 1. Pull it into your copy

Your `origin` stays as it is. Add this repo as a second remote and check the branch out:

```bash
git remote add dheeraj https://github.com/DheerajKumarRana/Meta-lead-assistance.git
git fetch dheeraj ui/ios26
git checkout -b ui/ios26 dheeraj/ui/ios26
```

Your `main` is untouched until you merge.

## 2. Check it locally

```bash
cd frontend
npm test            # 718 tests, all should pass
npx tsc --noEmit
npm run dev         # http://localhost:5173
```

Please look at these with the browser at phone width (DevTools → device toolbar, 390px):

- **Inbox list, chat thread, lead details**: the screens used most
- **Bottom tab bar**: a floating glass capsule, hidden automatically while a form sheet is open
- **Any dropdown** (e.g. Leads → "All enquiry types"): on phones it opens an iOS-style bottom
  sheet instead of the browser/Android picker (see "Dropdowns" below)
- **Dark mode**: toggle in the header

**Please also try one dropdown in the Android APK.** The sheet was tested with simulated touch in
Chrome/Edge, but not yet inside the Capacitor WebView. If the old Android dialog still appears
there, report it back. Either way the value is still set correctly, because the real `<select>`
is untouched underneath.

## 3. Merge and ship

```bash
git checkout main
git merge ui/ios26
git push origin main
```

Then rebuild **only the frontend**. The backend doesn't need a restart.

- **Web:** your usual frontend deploy (`npm run build`). Nothing else changes.
- **Android app:** build a new APK as usual (`npm run build` → `npx cap sync android` → build in
  Android Studio). Installed phones keep the old look until they get the new APK.

**To undo:** before merging, just delete the branch. After merging, `git revert` the merge commit.

## What changed, technically

So you know where things live when you next edit the UI:

1. **One design system in `frontend/src/index.css`.** Components still use the normal Tailwind
   palette (`text-slate-500`, `bg-blue-600`, ...), but the palette itself is redefined to Apple's
   system colours: slate/gray = iOS greys and label colours, blue = systemBlue `#007AFF`, green =
   systemGreen, and so on. That restyles the whole app without editing every component. Dark mode
   keeps your existing `html.dark` mechanism with Apple's dark values (true black base, `#1C1C1E`
   cards).
2. **Liquid Glass utilities**: `.glass`, `.glass-strong` and `.glass-pill` (the selected segment
   in a segmented control or tab bar).
3. **Phone type scale** (below `lg`): `text-xs` → 13px, `text-sm` → 15px, and the tiny arbitrary
   sizes (`text-[0.625rem]`, `text-[11px]`, ...) are raised to iOS's 11–13px floor. Done once in
   CSS rather than in every file.
4. **The 40px mobile tap-height rule now skips buttons that set their own height** (any `h-*` /
   `min-h-*` class). Before, it stretched round checkboxes into ovals and stacked small links
   into tall columns.
5. **Dropdowns**: all `<select>`s get the iOS up/down chevron. On phones,
   `components/mobile/SelectSheet.tsx` (mounted once in `main.tsx`, outside `<App />`) opens an
   iOS bottom sheet when a select is tapped. Choosing a row sets the real select's value and fires
   the normal `change` event, so every existing `onChange` runs exactly as before. It is
   registered with `mobile-back-stack`, so Android back closes it. Desktop, keyboard and jsdom
   tests still use the native control.
6. **Hand-tuned screens**: header (`MobileAppBar`: large title on tabs, buttons in one glass
   capsule), tab bar, sign-in page, inbox rows, chat bubbles and composer, lead details panel,
   tasks, dashboard KPI grid (2 columns on phones) and its range control, and the toggle switch
   (iOS green). Desktop shows the header as a floating glass bar and the inbox as rounded panes.
7. **One display fix:** rates on the dashboard are rounded to one decimal place (`71%`, not
   `70.96774193548387%`). The "no data shows a dash, never 0%" rule is unchanged.

## Already in `main` before this branch

`npm run lint` reports errors that were already on `main` before this branch and are left alone
here, for example `StagesPage` / `TagsPage` imported but unused in `pages/AppShell.tsx`. The files
this branch touched add no new lint errors.

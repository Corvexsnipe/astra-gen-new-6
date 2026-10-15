# Verification

- Run application regression tests with `node --test application-regression.test.cjs`. These use mocked MySQL and SMTP dependencies and do not contact production services. They check schema migration SQL, technical-support validation and inserts, connection cleanup, and rendered admin answers.
- Run TypeScript checking with `npx tsc --noEmit --incremental false`.
- Run the production build with `npm run build`; do not pipe through output truncation commands, which can hide the actual exit status.
- `lib/db.ts` uses the complete `SMTP_*` group if any SMTP setting is present, otherwise the legacy `EMAIL_*` group. Verification happens lazily on first send, so importing the module during a build does not contact SMTP.
- The local shell is Windows PowerShell; use separate tool calls instead of Bash `&&` chains.

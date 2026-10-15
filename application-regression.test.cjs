const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(file, mocks = {}, env = {}, globals = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(resolve(__dirname, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, require: (name) => mocks[name] ?? require(name),
    process: { env }, console: { log() {}, warn() {}, error() {} },
    Buffer, File, FormData, Response, setTimeout, clearTimeout,
    ...globals,
  }, { filename: file });
  return module.exports;
}

function database(fail = false) {
  const queries = [];
  let released = 0;
  const connection = {
    async query(sql) {
      queries.push(sql);
      if (fail && sql.includes('CREATE TABLE')) throw new Error('schema unavailable');
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('SHOW COLUMNS FROM staff')) return [[{ Field: 'application_id' }]];
      if (sql.includes('SHOW COLUMNS')) return [[
        { Field: 'identity_card_base64', Type: 'text', Null: 'YES' },
        { Field: 'passport_photo_base64', Type: 'text', Null: 'YES' },
        { Field: 'discord_username', Type: 'varchar(100)', Null: 'NO' },
      ]];
      return [[]];
    },
    release() { released++; },
  };
  const db = load('lib/db.ts', {
    'mysql2/promise': { createPool: () => ({ getConnection: async () => connection }) },
    nodemailer: { createTransport: () => ({}) },
  });
  return { db, queries, released: () => released };
}

test('existing document columns are widened without removing legacy data', async () => {
  const fixture = database();
  await fixture.db.initializeDatabase();
  assert.ok(fixture.queries.some(sql => /ALTER TABLE.*technical_support_applications/s.test(sql) && /MODIFY COLUMN.*identity_card_base64.*MEDIUMTEXT/s.test(sql)));
  assert.ok(fixture.queries.some(sql => /ADD COLUMN.*experience_letter_base64.*MEDIUMTEXT/s.test(sql)));
  assert.ok(fixture.queries.some(sql => /ADD COLUMN.*identity_card_front_base64.*MEDIUMTEXT/s.test(sql)));
  assert.ok(fixture.queries.some(sql => /MODIFY COLUMN.*discord_username.*NULL/s.test(sql)));
  assert.ok(!fixture.queries.some(sql => /DROP |TRUNCATE /i.test(sql)));
  assert.equal(fixture.released(), 1);
});

test('schema errors release the database connection and allow retries', async () => {
  const fixture = database(true);
  await assert.rejects(fixture.db.initializeDatabase());
  assert.equal(fixture.released(), 1);
  await assert.rejects(fixture.db.initializeDatabase());
  assert.equal(fixture.released(), 2);
});

test('concurrent schema initialization is shared and cached after success', async () => {
  const fixture = database();
  await Promise.all([fixture.db.initializeDatabase(), fixture.db.initializeDatabase()]);
  await fixture.db.initializeDatabase();
  assert.equal(fixture.released(), 1);
});

function renderAdmin(tab, application) {
  const states = [true, '', '', '', tab,
    [], tab === 'customer-support' ? [application] : [],
    tab === 'sales' ? [application] : [], tab === 'technical-support' ? [application] : [],
    false, null, 1, null];
  let index = 0;
  const { default: Admin } = load('app/admin-panel/page.tsx', {
    react: { ...React, useState: () => [states[index++], () => {}], useEffect: () => {}, useCallback: (callback) => callback },
  });
  return renderToStaticMarkup(React.createElement(Admin));
}

test('technical answers are visible in full, including long answers', () => {
  const answer = 'Detailed experience '.repeat(20) + 'UNIQUE_END_OF_ANSWER';
  const html = renderAdmin('technical-support', {
    id: 1, application_id: 'CAS-TEST', full_name: 'Test Applicant', created_at: '2026-01-01',
    pterodactyl_panel: answer, paymenter_panel: '', proxmox: '', vmware: '', linux: '', developing_ideas: '',
  });
  assert.ok(html.includes('UNIQUE_END_OF_ANSWER'));
});

test('customer support and sales details are not omitted', () => {
  for (const tab of ['customer-support', 'sales']) {
    const html = renderAdmin(tab, {
      id: 1, application_id: 'CAS-TEST', full_name: 'Test Applicant', created_at: '2026-01-01',
      previous_experience: 'UNIQUE_PREVIOUS_EXPERIENCE', why_hire: 'UNIQUE_HIRING_ANSWER',
      weekend_availability: 0,
    });
    assert.ok(html.includes('UNIQUE_PREVIOUS_EXPERIENCE'), tab);
    assert.ok(html.includes('UNIQUE_HIRING_ANSWER'), tab);
    assert.ok(html.includes('No'), tab);
  }
});

function submission({ fail = false, packetLimit = 64 * 1024 * 1024 } = {}) {
  const inserts = [];
  const deferred = [];
  let released = 0;
  const connection = {
    async query(sql, values) {
      if (sql.includes('max_allowed_packet')) return [[{ packetLimit }]];
      if (fail) throw Object.assign(new Error('private SQL details'), { code: 'ER_DATA_TOO_LONG' });
      inserts.push({ sql, values });
      return [[]];
    },
    release() { released++; },
  };
  const route = load('app/api/technical-support-applications/route.ts', {
    'next/server': { NextResponse: Response, after: (callback) => deferred.push(callback) },
    '@/lib/db': {
      __esModule: true, default: { getConnection: async () => connection },
      initializeDatabase: async () => {}, generateApplicationId: () => 'CAS-TEST',
      sendTechnicalSupportApplicationEmail: async () => { throw new Error('offline'); },
      sendAdminNotificationForTechnicalSupport: async () => {},
    },
  });
  return { route, inserts, deferred, released: () => released };
}

function formRequest(modify = () => {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    fullName: 'Test Applicant', age: '25', country: 'India', city: 'Test City',
    email: 'applicant@example.test', contactNumber: '1234567890', languages: 'English',
    documentsAvailability: 'yes', compensation: '500 USD', pterodactylPanel: 'Panel experience',
    paymenterPanel: 'Paymenter experience', proxmox: 'Proxmox experience', vmware: 'VMware experience',
    linux: 'Linux experience', developingIdeas: 'Developing experience', agreeToRules: 'true',
  })) form.set(key, value);
  for (const key of ['identityCard', 'passportPhoto']) {
    form.set(key, new File([Buffer.alloc(100 * 1024)], `${key}.png`, { type: 'image/png' }));
  }
  modify(form);
  return { headers: new Headers(), formData: async () => form };
}

test('technical submission saves documents over 64 KB and returns before email delivery', async () => {
  const fixture = submission();
  const response = await fixture.route.POST(formRequest());
  assert.equal(response.status, 201);
  assert.equal((await response.json()).applicationId, 'CAS-TEST');
  assert.equal(fixture.inserts.length, 1);
  assert.equal(fixture.inserts[0].values.length, 19);
  assert.ok(fixture.inserts[0].values[16].length > 65535);
  assert.equal(fixture.released(), 1);
  assert.equal(fixture.deferred.length, 1);
  await fixture.deferred[0]();
});

test('invalid, missing and oversized uploads are rejected before insertion', async () => {
  for (const [modify, status] of [
    [form => form.delete('identityCard'), 400],
    [form => form.set('fullName', '   '), 400],
    [form => form.set('age', '-1'), 400],
    [form => form.set('identityCard', 'not a file'), 400],
    [form => form.set('passportPhoto', new File(['text'], 'photo.txt', { type: 'text/plain' })), 400],
    [form => form.set('identityCard', new File([Buffer.alloc(6 * 1024 * 1024)], 'id.png', { type: 'image/png' })), 413],
  ]) {
    const fixture = submission();
    assert.equal((await fixture.route.POST(formRequest(modify))).status, status);
    assert.equal(fixture.inserts.length, 0);
  }
});

test('database failures and packet limits release connections without leaking SQL', async () => {
  for (const [options, status] of [[{ fail: true }, 500], [{ packetLimit: 65536 }, 413]]) {
    const fixture = submission(options);
    const response = await fixture.route.POST(formRequest());
    assert.equal(response.status, status);
    assert.equal(fixture.released(), 1);
    assert.ok(!(await response.text()).includes('private SQL'));
  }
});

test('technical listing disables caching and releases connections on failure', async () => {
  const success = submission();
  const response = await success.route.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(success.released(), 1);
  const failure = submission({ fail: true });
  assert.equal((await failure.route.GET()).status, 500);
  assert.equal(failure.released(), 1);
});

function mailFixture({ reject = false, env = {} } = {}) {
  let options;
  let verified = 0;
  const messages = [];
  const db = load('lib/db.ts', {
    'mysql2/promise': { createPool: () => ({}) },
    nodemailer: { createTransport: (config) => {
      options = config;
      return {
        verify: async () => { verified++; return true; },
        sendMail: async (message) => {
          messages.push(message);
          return { messageId: 'test', accepted: reject ? [] : [message.to], rejected: reject ? [message.to] : [] };
        },
      };
    } },
  }, { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_USER: 'sender@example.test', SMTP_PASS: 'test-only-password', SMTP_FROM: 'sender@example.test', ...env });
  return { db, options, messages, verified: () => verified };
}

test('SMTP variables work, TLS matches the port, verification is cached, and email contains the saved ID', async () => {
  const fixture = mailFixture();
  await fixture.db.sendSalesApplicationEmail('Applicant', 'applicant@example.test', 'CAS-SAVED-ID');
  await fixture.db.sendCustomerSupportApplicationEmail('Applicant', 'applicant@example.test', 'CAS-SAVED-ID');
  assert.equal(fixture.options.secure, true);
  assert.equal(fixture.options.auth.user, 'sender@example.test');
  assert.equal(fixture.verified(), 1);
  assert.equal(fixture.messages.length, 2);
  assert.ok(fixture.messages.every(message => message.html.includes('CAS-SAVED-ID')));
});

test('recipient rejection is not reported as successful email delivery', async () => {
  const fixture = mailFixture({ reject: true });
  await assert.rejects(fixture.db.sendSalesApplicationEmail('Applicant', 'applicant@example.test', 'CAS-SAVED-ID'));
});

test('port 587 requires STARTTLS and legacy EMAIL configuration still works', async () => {
  const fixture = mailFixture({ env: {
    SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
    EMAIL_HOST: 'smtp.example.test', EMAIL_PORT: '587', EMAIL_USER: 'legacy@example.test',
    EMAIL_PASS: 'test-only-password', EMAIL_FROM: 'legacy@example.test',
  } });
  await fixture.db.sendSalesApplicationEmail('Applicant', 'applicant@example.test', 'CAS-LEGACY');
  assert.equal(fixture.options.secure, false);
  assert.equal(fixture.options.requireTLS, true);
  assert.equal(fixture.messages[0].from, 'legacy@example.test');
});

test('incomplete SMTP configuration does not borrow unrelated legacy credentials', async () => {
  const fixture = mailFixture({ env: { SMTP_PASS: '', EMAIL_PASS: 'wrong-provider-password' } });
  await assert.rejects(fixture.db.sendSalesApplicationEmail('Applicant', 'applicant@example.test', 'CAS-TEST'));
  assert.equal(fixture.verified(), 0);
  assert.equal(fixture.messages.length, 0);
});

const documentHelpers = load('lib/application-documents.ts');
const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
const jpegBytes = Buffer.from([255, 216, 255, 224, 0, 1]);

function applicationForm(modify = () => {}) {
  const form = new FormData();
  for (const name of [
    'fullName', 'country', 'city', 'contactNumber', 'languages', 'previousExperience',
    'hostingExperience', 'hostingExperienceDetails', 'expectedSalary', 'convinceCustomer',
    'expensiveResponse', 'minecraftServerInfo', 'ramCpuDifference', 'lagDiagnosis', 'whyHire',
    'handleAngryCustomer', 'handleUnknownSolution', 'prioritizeMultipleCustomers',
    'explainTechnicalIssue', 'minecraftServerCheck',
  ]) form.set(name, `Answer for ${name}`);
  form.set('age', '25');
  form.set('dailyHours', '8');
  form.set('agreeToRules', 'true');
  form.set('email', 'applicant@example.test');
  form.set('identityCardFront', new File([pngBytes], 'front.png', { type: 'image/png' }));
  form.set('identityCard', new File([jpegBytes], 'back.jpg', { type: 'image/jpeg' }));
  form.set('passportPhoto', new File([pngBytes], 'photo.png', { type: 'image/png' }));
  form.set('experienceLetter', new File(['%PDF-1.7\nsample'], 'letter.pdf', { type: 'application/pdf' }));
  modify(form);
  return form;
}

function salesOrSupport(category, failEmail = false) {
  const inserts = [];
  const emails = [];
  let released = 0;
  const connection = {
    async query(sql, values) {
      if (sql.includes('max_allowed_packet')) return [[{ packetLimit: 64 * 1024 * 1024 }]];
      inserts.push({ sql, values });
      return [{ insertId: 1 }];
    },
    release() { released++; },
  };
  const send = async (name, email, id) => {
    assert.equal(inserts.length, 1);
    emails.push({ name, email, id });
    if (failEmail) throw new Error('SMTP unavailable');
  };
  const route = load(`app/api/${category}-applications/route.ts`, {
    'next/server': { NextResponse: Response },
    '@/lib/application-documents': documentHelpers,
    '@/lib/db': {
      __esModule: true, default: { getConnection: async () => connection },
      initializeDatabase: async () => {}, generateApplicationId: () => 'CAS-SAVED-ONLY',
      sendSalesApplicationEmail: send, sendCustomerSupportApplicationEmail: send,
      sendAdminNotificationForSales: async () => {}, sendAdminNotificationForCustomerSupport: async () => {},
    },
  });
  return { route, inserts, emails, released: () => released };
}

test('both applications save separate ID sides and send the saved ID to the applicant', async () => {
  for (const category of ['sales', 'customer-support']) {
    const fixture = salesOrSupport(category);
    const response = await fixture.route.POST({ formData: async () => applicationForm() });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.applicationId, 'CAS-SAVED-ONLY');
    assert.equal(result.emailStatus, 'sent');
    const { sql, values } = fixture.inserts[0];
    const columns = sql.match(/INSERT INTO \w+\s*\(([^)]+)\)/)[1].split(',').map(value => value.trim());
    assert.equal(columns.length, values.length);
    assert.equal(values[columns.indexOf('identity_card_front_base64')], pngBytes.toString('base64'));
    assert.equal(values[columns.indexOf('identity_card_base64')], jpegBytes.toString('base64'));
    assert.equal(values[columns.indexOf('application_id')], result.applicationId);
    assert.equal(fixture.emails[0].id, result.applicationId);
    assert.equal(fixture.emails[0].email, values[columns.indexOf('email')]);
    assert.equal(fixture.released(), 1);
  }
});

test('missing ID sides, wrong letter formats, spoofed PDFs and oversized files return validation errors', async () => {
  for (const category of ['sales', 'customer-support']) {
    for (const [modify, status] of [
      [form => form.delete('identityCardFront'), 400],
      [form => form.delete('identityCard'), 400],
      [form => form.set('experienceLetter', new File([pngBytes], 'letter.png', { type: 'image/png' })), 400],
      [form => form.set('experienceLetter', new File(['not PDF'], 'letter.pdf', { type: 'application/pdf' })), 400],
      [form => form.set('identityCardFront', new File(['%PDF-1.7'], 'id.pdf', { type: 'application/pdf' })), 400],
      [form => form.set('identityCardFront', new File([Buffer.alloc(6 * 1024 * 1024)], 'large.png', { type: 'image/png' })), 413],
    ]) {
      const fixture = salesOrSupport(category);
      const response = await fixture.route.POST({ formData: async () => applicationForm(modify) });
      assert.equal(response.status, status, category);
      assert.equal(fixture.inserts.length, 0);
      assert.equal(fixture.emails.length, 0);
    }
  }
});

test('optional letters can be omitted and email failure still returns the saved ID', async () => {
  for (const category of ['sales', 'customer-support']) {
    const fixture = salesOrSupport(category, true);
    const response = await fixture.route.POST({ formData: async () => applicationForm(form => form.delete('experienceLetter')) });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.applicationId, 'CAS-SAVED-ONLY');
    assert.equal(result.emailStatus, 'failed');
    assert.equal(fixture.inserts.length, 1);
  }
});

test('both success screens display the server ID and honest email status', async () => {
  const receiptModule = load('components/ApplicationReceipt.tsx');
  for (const category of ['sales', 'customer-support']) {
    for (const emailStatus of ['sent', 'failed']) {
      const states = [];
      let index = 0;
      const formModule = load(`app/${category}-application/page.tsx`, {
        '@/components/ApplicationReceipt': receiptModule,
        react: { ...React,
          useState: initial => {
            const position = index++;
            if (!(position in states)) states[position] = initial;
            return [states[position], value => { states[position] = typeof value === 'function' ? value(states[position]) : value; }];
          },
          useMemo: callback => callback(), useEffect: () => {},
        },
      }, {}, {
        window: { scrollTo() {} },
        fetch: async () => Response.json({ applicationId: 'CAS-SERVER-RECEIPT', emailStatus }, { status: 201 }),
        alert: message => { throw new Error(message); },
      });
      function findForm(element) {
        if (!element || typeof element !== 'object') return null;
        if (element.type === 'form') return element;
        return React.Children.toArray(element.props?.children).map(findForm).find(Boolean);
      }
      index = 0;
      const form = findForm(formModule.default());
      assert.ok(form, category);
      await form.props.onSubmit({ preventDefault() {} });
      index = 0;
      const html = renderToStaticMarkup(formModule.default());
      assert.ok(html.includes('CAS-SERVER-RECEIPT'), category);
      assert.ok(html.includes(emailStatus === 'sent' ? 'accepted by our email service' : 'could not send'), category);
    }
  }
});

test('admin exposes separate front and back previews for both application categories', () => {
  for (const category of ['sales', 'customer-support']) {
    const html = renderAdmin(category, {
      id: 1, full_name: 'Applicant', created_at: '2026-01-01',
      identity_card_front_base64: pngBytes.toString('base64'),
      identity_card_base64: jpegBytes.toString('base64'),
    });
    assert.ok(html.includes('ID Card Front'));
    assert.ok(html.includes('ID Card Back'));
  }
});

test('all application inserts have matching columns and placeholders', () => {
  for (const category of ['sales', 'customer-support', 'technical-support']) {
    const source = readFileSync(resolve(__dirname, `app/api/${category}-applications/route.ts`), 'utf8');
    const match = source.match(/INSERT INTO \w+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/);
    assert.ok(match);
    assert.equal(match[1].split(',').length, match[2].split(',').length, category);
  }
});

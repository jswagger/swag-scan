import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gatherTicketContext } from '../../bug-hunter/scripts/gather-context.mjs';
import { TicketFileError, findTicketFile, findUnreadableTicket, htmlToText, jiraXmlToTicketMarkdown, parseTicket, readTicketText } from '../ticket.mjs';

const wrap = (...items) => `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="0.92"><channel><title>Jira</title><description>This file is an XML representation of an issue</description>${items.join('')}</channel></rss>`;
const COMMENTS = '<comments><comment id="1" author="dev" created="Mon">Dev note: retry loop already done</comment></comments>';
const criteriaField = (value) => `<customfields><customfield id="customfield_10200" key="x:textarea"><customfieldname>Acceptance Criteria</customfieldname><customfieldvalues><customfieldvalue>${value}</customfieldvalue></customfieldvalues></customfield><customfield id="customfield_10300" key="x:select"><customfieldname>Department</customfieldname><customfieldvalues><customfieldvalue>Payments</customfieldvalue></customfieldvalues></customfield></customfields>`;

// Older style: the HTML is escaped as XML entities. Criteria live in a custom field.
const ESCAPED = wrap(`<item><title>[ID-123] Add checkout retry</title><link>https://example.invalid/browse/ID-123</link><project id="1" key="ID">Checkout</project>
<description>&lt;p&gt;Retry a failed payment up to 3 times &amp;amp; log each try.&lt;/p&gt;&lt;p&gt;Show a "Try again" message.&lt;/p&gt;</description>
<key id="10042">ID-123</key><summary>Add checkout retry</summary><type id="1">Story</type><status id="3">In Progress</status>${COMMENTS}
${criteriaField('&lt;ul&gt;&lt;li&gt;Retries 3 times&lt;/li&gt;&lt;li&gt;Shows an error after the last retry&lt;/li&gt;&lt;li&gt;Logs each attempt&lt;/li&gt;&lt;/ul&gt;')}</item>`);

// Newer style: the HTML tags are written straight into the XML. Criteria are a heading plus a list in the description.
const EMBEDDED = wrap(`<item><title>[ID-7] Login form</title><description><p>Users sign in with email.</p><p><strong>Acceptance Criteria</strong></p><ul><li>Shows the form</li><li>Locks after 5 tries</li></ul></description><key id="2">ID-7</key><summary>Login form</summary>${COMMENTS}</item>`);

const CDATA = wrap('<item><title>[ID-8] Cdata</title><description><![CDATA[<p>Body &amp; more</p>]]></description><key id="3">ID-8</key><summary>Cdata</summary></item>');

function folder(context, files = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'swag-xml-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
  return directory;
}

test('escaped HTML: title, description and the Acceptance Criteria custom field, and nothing else', () => {
  const markdown = jiraXmlToTicketMarkdown(ESCAPED, 'ID-123');
  assert.match(markdown, /^# ID-123: Add checkout retry/);
  assert.match(markdown, /## Description\n\nRetry a failed payment up to 3 times & log each try\.\n\nShow a "Try again" message\./);
  assert.match(markdown, /## Acceptance Criteria\n\n- Retries 3 times\n- Shows an error after the last retry\n- Logs each attempt/);
  assert.doesNotMatch(markdown, /Dev note|In Progress|Payments|example\.invalid/, 'comments, status, other custom fields and links stay out');
  assert.equal(parseTicket(markdown).acceptanceCriteria.length, 3);
});

test('HTML written straight into the XML: an Acceptance Criteria line in the description becomes a heading', () => {
  const markdown = jiraXmlToTicketMarkdown(EMBEDDED, 'ID-7');
  assert.match(markdown, /Users sign in with email\.\n\n### Acceptance Criteria\n\n- Shows the form\n- Locks after 5 tries/);
  assert.doesNotMatch(markdown, /Dev note/);
  assert.equal(parseTicket(markdown).acceptanceCriteria.length, 2);
});

test('HTML in a CDATA block is read, and entities in it are decoded once', () => {
  assert.match(jiraXmlToTicketMarkdown(CDATA, 'ID-8'), /## Description\n\nBody & more/);
  assert.equal(htmlToText('a &amp;lt; b'), 'a &lt; b');
  assert.equal(htmlToText('<p>x &lt; y</p><script>alert(1)</script>'), 'x < y');
  assert.equal(htmlToText('<h2>Title</h2><p>Body<br/>next</p>'), '### Title\n\nBody\nnext');
});

test('a search export with several issues gives the one whose key matches', () => {
  const xml = wrap(
    '<item><title>[ID-1] First</title><description>&lt;p&gt;One&lt;/p&gt;</description><key id="1">ID-1</key><summary>First</summary></item>',
    '<item><title>[ID-2] Second</title><description>&lt;p&gt;Two&lt;/p&gt;</description><key id="2">ID-2</key><summary>Second</summary></item>',
  );
  assert.match(jiraXmlToTicketMarkdown(xml, 'id-2'), /^# ID-2: Second\n\n## Description\n\nTwo/);
  assert.throws(() => jiraXmlToTicketMarkdown(xml, 'ID-9'), (error) => error instanceof TicketFileError && /ID-9 is not in this XML, which holds 2 issues/.test(error.message));
});

test('a one-issue file needs no matching id, and the summary falls back to the title', () => {
  const xml = wrap('<item><title>[ABC-5] From the title</title><key id="5">ABC-5</key></item>');
  assert.match(jiraXmlToTicketMarkdown(xml, 'ID-1'), /^# ABC-5: From the title/);
});

test('text that is not a Jira XML export says what to do', () => {
  assert.throws(() => jiraXmlToTicketMarkdown('<html><body>login</body></html>', 'ID-1'), (error) => error instanceof TicketFileError && /does not look like a Jira XML export.*Export XML/.test(error.message));
  assert.throws(() => jiraXmlToTicketMarkdown('', 'ID-1'), TicketFileError);
});

test('lookup finds ID.xml and renamed downloads, and Word and Excel files point to Export XML', (context) => {
  const directory = folder(context, { 'ID-1.xml': ESCAPED, 'ID-2 (1).xml': EMBEDDED, 'ID-3.doc': '<html>', 'ID-4.xls': '<html>', 'ID-5.docx': 'x', 'ID-6.xlsx': 'x' });
  assert.equal(findTicketFile(directory, 'ID-1'), join(directory, 'ID-1.xml'));
  assert.equal(findTicketFile(directory, 'ID-2'), join(directory, 'ID-2 (1).xml'));
  for (const [id, name] of [['ID-3', 'ID-3.doc'], ['ID-4', 'ID-4.xls'], ['ID-5', 'ID-5.docx'], ['ID-6', 'ID-6.xlsx']]) {
    assert.equal(findTicketFile(directory, id), undefined);
    assert.equal(findUnreadableTicket(directory, id), name);
  }
  assert.throws(() => readTicketText(join(directory, 'ID-3.doc')), (error) => error instanceof TicketFileError && /Word or Excel export.*Export XML.*ID-3\.xml/.test(error.message));
});

test('gatherTicketContext reads ID-123.xml from the settings folder', (context) => {
  const directory = folder(context, { 'ID-123.xml': ESCAPED, 'ID-4.xls': '<html>' });
  const userSettings = { ticketFolder: directory };
  const found = gatherTicketContext(undefined, 'ID-123', { userSettings, branch: 'main' });
  assert.equal(found.found, true);
  assert.equal(found.title, 'ID-123: Add checkout retry');
  assert.equal(found.acceptanceCriteria.length, 3);
  assert.doesNotMatch(found.content, /Dev note/);
  assert.match(gatherTicketContext(undefined, 'ID-4', { userSettings, branch: 'main' }).notes[0], /Found ID-4\.xls.*Export XML.*ID-4\.xml/);
  assert.match(gatherTicketContext(undefined, 'ID-9', { userSettings, branch: 'main' }).notes[0], /No ID-9\.xml, ID-9\.md or ID-9\.txt found/);
});

test('a broken XML file is a note, not a crash', (context) => {
  const directory = folder(context, { 'ID-5.xml': '<html>not jira</html>' });
  const note = gatherTicketContext(undefined, 'ID-5', { userSettings: { ticketFolder: directory }, branch: 'main' }).notes[0];
  assert.match(note, /does not look like a Jira XML export/);
});

test('a real Jira Cloud export: escaped HTML, nested lists, other custom fields ignored', () => {
  const xml = `<rss version="0.92"><channel><item>
<title>[PROJ-123] Summary Feature - Option to Move to Chat</title>
<description>
&lt;p&gt;User Story:&lt;/p&gt;

&lt;p&gt;As a user I want to take the summary to Chat.&lt;/p&gt;</description>
<key id="100001">PROJ-123</key>
<summary>Summary Feature - Option to Move to Chat</summary>
<comments><comment id="1">Please ignore this</comment></comments>
<customfields>
<customfield id="customfield_10028"><customfieldname>Acceptance Criteria</customfieldname><customfieldvalues>
<customfieldvalue>&lt;ol&gt;
	&lt;li&gt;Add a button named &quot;Move to Chat&quot;.&lt;/li&gt;
	&lt;li&gt;Clicking it shows a prompt:
	&lt;ol&gt;
		&lt;li&gt;{{Are you sure?}}&lt;/li&gt;
	&lt;/ol&gt;
	&lt;/li&gt;
	&lt;li&gt;Add an analytics event.&lt;/li&gt;
&lt;/ol&gt;

&lt;p&gt;&lt;span class=&quot;image-wrap&quot;&gt;&lt;img src=&quot;https://example.atlassian.net/a.png&quot; /&gt;&lt;/span&gt;&lt;/p&gt;

&lt;p&gt;&lt;b&gt;Testing Notes:&lt;/b&gt;&lt;/p&gt;

&lt;ul&gt;
	&lt;li&gt;Test a multi-owner item&lt;/li&gt;
&lt;/ul&gt;
</customfieldvalue></customfieldvalues></customfield>
<customfield id="customfield_10102"><customfieldname>Dev Notes</customfieldname><customfieldvalues><customfieldvalue>&lt;p&gt;Use SummaryDialog.tsx&lt;/p&gt;</customfieldvalue></customfieldvalues></customfield>
</customfields></item></channel></rss>`;
  const markdown = jiraXmlToTicketMarkdown(xml, 'PROJ-123');
  const ticket = parseTicket(markdown);
  assert.equal(ticket.title, 'PROJ-123: Summary Feature - Option to Move to Chat');
  assert.match(ticket.description, /As a user I want to take the summary to Chat/);
  assert.deepEqual(ticket.acceptanceCriteria.map((c) => c.description), [
    'Add a button named "Move to Chat".',
    'Clicking it shows a prompt:',
    '{{Are you sure?}}',
    'Add an analytics event.',
  ]);
  assert.match(markdown, /^ {2}- \{\{Are you sure\?\}\}$/m);
  assert.ok(ticket.omittedSections.includes('Testing Notes'));
  assert.doesNotMatch(markdown, /SummaryDialog|ignore this/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { jiraXmlToTicketMarkdown, htmlToText, parseTicket, TicketFileError } from '../ticket.mjs';

test('reads Jira XML escaped description and acceptance criteria', () => {
  const xml = `<?xml version="1.0"?>
<rss><channel><item>
<title>[ID-123] Add checkout retry</title>
<description>&lt;p&gt;Retry a failed payment.&lt;/p&gt;</description>
<key id="10042">ID-123</key>
<summary>Add checkout retry</summary>
<customfields><customfield><customfieldname>Acceptance Criteria</customfieldname><customfieldvalues>
<customfieldvalue>&lt;ul&gt;&lt;li&gt;Retries 3 times&lt;/li&gt;&lt;li&gt;Shows an error&lt;/li&gt;&lt;/ul&gt;</customfieldvalue>
</customfieldvalues></customfield></customfields>
</item></channel></rss>`;
  const markdown = jiraXmlToTicketMarkdown(xml, 'ID-123');
  assert.match(markdown, /^# ID-123: Add checkout retry/);
  assert.match(markdown, /## Description\n\nRetry a failed payment\./);
  assert.match(markdown, /- Retries 3 times\n- Shows an error/);
  assert.equal(parseTicket(markdown).acceptanceCriteria.length, 2);
});

test('reads embedded and CDATA HTML and selects a matching issue', () => {
  const xml = `<rss><channel>
<item><title>[ID-1] First</title><key>ID-1</key><summary>First</summary><description><p>One</p></description></item>
<item><title>[ID-2] Second</title><key>ID-2</key><summary>Second</summary><description><![CDATA[<p>Body &amp; more</p>]]></description></item>
</channel></rss>`;
  assert.match(jiraXmlToTicketMarkdown(xml, 'ID-2'), /Body & more/);
  assert.equal(htmlToText('<h2>Title</h2><p>Body<br/>next</p>'), '### Title\n\nBody\nnext');
  assert.throws(() => jiraXmlToTicketMarkdown('<html></html>', 'ID-1'), TicketFileError);
});

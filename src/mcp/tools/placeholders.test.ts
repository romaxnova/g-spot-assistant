import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPlaceholders } from './placeholders.js';

const inText = (text: string) => findPlaceholders({ texts: [text] });

test('blanks Claude leaves when a detail is missing are found, each once and in order', () => {
  assert.deepEqual(inText('Bonjour [Prénom],\nJe suis joignable au [téléphone] ou au [téléphone].'), ['[Prénom]', '[téléphone]']);
  assert.deepEqual(inText('Dear {{first_name}}, see <<COMPANY NAME>>.'), ['{{first_name}}', '<<COMPANY NAME>>']);
  assert.deepEqual(inText('Tél. : 06 XX XX XX XX'), ['06 XX XX XX XX']);
  assert.deepEqual(inText('Tel XX.XX.XX.XX.XX, code postal XXXXX'), ['XX.XX.XX.XX.XX', 'XXXXX']);
  assert.deepEqual(inText('[Your Name]\n[Company]'), ['[Your Name]', '[Company]']);
  assert.deepEqual(inText('Budget : [montant à compléter] €'), ['[montant à compléter]']);
});

test('brackets that are not blanks are left alone', () => {
  assert.deepEqual(inText('Voir la note [1] et [12]; [sic]; [...] ; […]'), []);
  assert.deepEqual(inText('[image: logo.png]\n[cid:image001.png@01DA]\n[https://example.com/x]\n[mailto:ann@example.com]'), []);
  assert.deepEqual(inText('Contact: [ann@example.com]'), []);
  assert.deepEqual(inText('Read [the guide](https://example.com)'), []);
  assert.deepEqual(inText('Size XL, XXL; a [x] box'), []);
  assert.deepEqual(inText('Numéro : 01 23 45 67 89'), []);
  assert.deepEqual(inText(''), []);
});

test('a subject\'s leading reply prefixes and list tags are not blanks; later ones are', () => {
  assert.deepEqual(findPlaceholders({ subject: 'Re: [Devis] Monument' }), []);
  assert.deepEqual(findPlaceholders({ subject: 'TR: RE: [list] [other] Offre' }), []);
  assert.deepEqual(findPlaceholders({ subject: 'Devis pour [Nom du client]' }), ['[Nom du client]']);
  assert.deepEqual(findPlaceholders({ subject: 'Devis {{name}}', texts: ['Merci [Prénom]', undefined] }), ['{{name}}', '[Prénom]']);
});

test('at most ten blanks are listed', () => {
  const text = Array.from({ length: 15 }, (_, i) => `[champ ${String.fromCharCode(97 + i)}]`).join(' ');
  assert.equal(inText(text).length, 10);
});

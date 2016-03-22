import './support';

import { spawnPromise, spawnDetachedPromise } from '../src/index';

const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('The spawnPromise method', function() {
  it('should return a uuid when we call uuid', async function() {
    // NB: Since we get run via npm run test, we know that npm bins are in our
    // PATH.
    let result = await spawnPromise('uuid', []);
    expect(result.match(uuidRegex)).to.be.ok;
  });
});

describe('The spawnDetachedPromise method', function() {
  it('should return a uuid when we call uuid', async function() {
    // NB: Since we get run via npm run test, we know that npm bins are in our
    // PATH.
    let result = await spawnDetachedPromise('uuid', ['--help']);
    expect(result.length > 10).to.be.ok;
  });
});

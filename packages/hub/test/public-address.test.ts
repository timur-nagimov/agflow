import { describe, expect, test } from 'bun:test';
import { FetchRefusal, classifyAddress, isPublicAddress, parseFetchUrl } from '../src/public-address';

describe('public addresses', () => {
  test('ordinary internet addresses are public', () => {
    for (const address of [
      '1.1.1.1',
      '8.8.8.8',
      '93.184.216.34',
      '100.63.255.255',
      '100.128.0.0',
      '172.15.255.255',
      '172.32.0.0',
      '192.0.1.1',
      '192.167.255.255',
      '198.17.255.255',
      '198.20.0.0',
      '223.255.255.255',
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
      '2a00:1450:4001:81b::200e',
      '2001:200::1',
      '2003::1',
      '3ffe::1',
    ]) {
      expect([address, classifyAddress(address)]).toEqual([address, 'public']);
      expect(isPublicAddress(address)).toBe(true);
    }
  });

  test('every IPv4 range that is not public unicast is refused, with its name', () => {
    const refused: [string, string][] = [
      ['0.0.0.0', 'unspecified'],
      ['0.1.2.3', 'unspecified'],
      ['10.0.0.1', 'private'],
      ['10.255.255.255', 'private'],
      ['100.64.0.1', 'carrier-grade NAT'],
      ['100.127.255.255', 'carrier-grade NAT'],
      ['127.0.0.1', 'loopback'],
      ['127.255.255.254', 'loopback'],
      ['169.254.169.254', 'link-local'],
      ['169.254.0.1', 'link-local'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['192.0.0.1', 'reserved'],
      ['192.0.2.1', 'documentation'],
      ['192.88.99.1', 'reserved'],
      ['192.168.0.1', 'private'],
      ['192.168.255.255', 'private'],
      ['198.18.0.1', 'reserved'],
      ['198.19.255.255', 'reserved'],
      ['198.51.100.7', 'documentation'],
      ['203.0.113.7', 'documentation'],
      ['224.0.0.1', 'multicast'],
      ['239.255.255.255', 'multicast'],
      ['240.0.0.1', 'reserved'],
      ['255.255.255.255', 'reserved'],
    ];
    for (const [address, kind] of refused) {
      expect([address, classifyAddress(address)]).toEqual([address, kind]);
      expect([address, isPublicAddress(address)]).toEqual([address, false]);
    }
  });

  test('every IPv6 range that is not global unicast is refused, with its name', () => {
    const refused: [string, string][] = [
      ['::', 'unspecified'],
      ['::1', 'loopback'],
      ['0:0:0:0:0:0:0:1', 'loopback'],
      ['fe80::1', 'link-local'],
      ['febf::1', 'link-local'],
      ['fc00::1', 'unique local'],
      ['fd12:3456:789a::1', 'unique local'],
      ['fec0::1', 'reserved'],
      ['ff02::1', 'multicast'],
      ['ff0e::1', 'multicast'],
      ['2001:db8::1', 'documentation'],
      ['3fff::1', 'documentation'],
      ['3fff:fff:ffff::1', 'documentation'],
      ['2001::1', 'reserved'],
      ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved'],
      ['2001:10::1', 'reserved'],
      ['2002:7f00:1::1', 'reserved'],
      ['2002:c0a8:1::1', 'reserved'],
      ['100::1', 'reserved'],
      ['4000::1', 'reserved'],
      ['::2', 'reserved'],
      ['::7f00:1', 'reserved'],
      ['64:ff9b:1::a00:1', 'reserved'],
    ];
    for (const [address, kind] of refused) {
      expect([address, classifyAddress(address)]).toEqual([address, kind]);
      expect([address, isPublicAddress(address)]).toEqual([address, false]);
    }
  });

  test('IPv4-mapped addresses are refused whatever they embed, and NAT64 ones by what they embed', () => {
    for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:8.8.8.8', '::ffff:808:808']) {
      expect([address, classifyAddress(address)]).toEqual([address, 'IPv4-mapped']);
    }
    const nat64: [string, string][] = [
      ['64:ff9b::7f00:1', 'loopback'],
      ['64:ff9b::127.0.0.1', 'loopback'],
      ['64:ff9b::a00:1', 'private'],
      ['64:ff9b::a9fe:a9fe', 'link-local'],
      ['64:ff9b::c0a8:101', 'private'],
      ['64:ff9b::6440:1', 'carrier-grade NAT'],
      ['64:ff9b::', 'unspecified'],
      ['64:ff9b::808:808', 'public'],
    ];
    for (const [address, kind] of nat64) expect([address, classifyAddress(address)]).toEqual([address, kind]);
  });

  test('anything that is not an address in its plain form is refused', () => {
    for (const address of [
      '',
      'example.com',
      '127.1',
      '0x7f.0.0.1',
      '0177.0.0.1',
      '2130706433',
      '1.2.3.4.5',
      '256.1.1.1',
      '1.2.3',
      '01.2.3.4',
      ' 1.1.1.1',
      '1.1.1.1 ',
      '[::1]',
      'fe80::1%en0',
      '2606:4700::1%1',
      ':::1',
      '1::2::3',
      '12345::1',
      '2606:4700:4700:0:0:0:0:0:1111',
      'g::1',
    ]) {
      expect([address, classifyAddress(address)]).toEqual([address, 'invalid']);
      expect([address, isPublicAddress(address)]).toEqual([address, false]);
    }
  });
});

describe('the URLs the hub fetches', () => {
  const refusal = (url: string): string => {
    try {
      parseFetchUrl(url);
    } catch (error) {
      if (error instanceof FetchRefusal) return error.message;
      throw error;
    }
    return 'accepted';
  };

  test('an http or https URL with a DNS host name is accepted, without its fragment', () => {
    expect(parseFetchUrl('https://example.com/data.csv?x=1#section').href).toBe('https://example.com/data.csv?x=1');
    expect(parseFetchUrl('http://EXAMPLE.com').href).toBe('http://example.com/');
    expect(parseFetchUrl('https://sub.example.co.uk/a%20b').href).toBe('https://sub.example.co.uk/a%20b');
    expect(parseFetchUrl('https://xn--e1afmkfd.xn--p1ai/').hostname).toBe('xn--e1afmkfd.xn--p1ai');
    expect(parseFetchUrl('https://пример.рф/').hostname).toBe('xn--e1afmkfd.xn--p1ai');
    expect(parseFetchUrl('https://1.1.1.1.example.com/').hostname).toBe('1.1.1.1.example.com');
    // The default port may be written out; the URL parser drops it.
    expect(parseFetchUrl('https://example.com:443/').href).toBe('https://example.com/');
    expect(parseFetchUrl('http://example.com:80/').href).toBe('http://example.com/');
  });

  test('other schemes are refused', () => {
    for (const url of ['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'data:text/plain,hi', 'javascript:alert(1)', 'ws://example.com/', 'example.com', '//example.com/', '']) {
      expect([url, refusal(url)]).not.toEqual([url, 'accepted']);
    }
    expect(refusal('ftp://example.com/')).toContain('http');
  });

  test('only the default ports are reached', () => {
    for (const url of ['http://example.com:8080/', 'https://example.com:8443/', 'http://example.com:443/', 'https://example.com:80/', 'http://example.com:22/', 'http://example.com:0/']) {
      expect([url, refusal(url)]).toEqual([url, expect.stringContaining('port')]);
    }
  });

  test('credentials in the URL are refused', () => {
    for (const url of ['https://user:pw@example.com/', 'https://user@example.com/', 'https://:pw@example.com/', 'http://example.com@evil.example.org/']) {
      expect([url, refusal(url)]).toEqual([url, expect.stringContaining('user name')]);
    }
  });

  test('an IP address is refused in every spelling', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://8.8.8.8/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0x7f.0.0.1/',
      'http://0x7f.1/',
      'http://017700000001/',
      'http://0177.0.0.1/',
      'http://127.1/',
      'http://127.0.0.1./',
      'http://%31%32%37.0.0.1/',
      'http://①②⑦.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[fe80::1]/',
      'http://[2606:4700:4700::1111]/',
      'http://[64:ff9b::7f00:1]/',
      'https://169.254.169.254/latest/meta-data/',
      'http://0/',
      'http://1.2.3.4.5/',
      'http://999.1.1.1/',
    ]) {
      expect([url, refusal(url)]).not.toEqual([url, 'accepted']);
    }
    expect(refusal('http://2130706433/')).toContain('IP address');
    expect(refusal('http://[::1]/')).toContain('IP address');
  });

  test('a host that is not a DNS name with a dot is refused', () => {
    for (const url of ['http://localhost/', 'http://metadata/', 'http://example.com./', 'http://exa_mple.com/', 'http://-a.example.com/', 'http://a-.example.com/', 'http://example.123/', `http://${'a'.repeat(64)}.example.com/`, `http://${'a.'.repeat(130)}com/`]) {
      expect([url, refusal(url)]).not.toEqual([url, 'accepted']);
    }
    expect(refusal('http://localhost/')).toContain('host name');
  });

  test('a URL over 2000 characters, or with whitespace, control characters or a backslash, is refused', () => {
    expect(refusal(`https://example.com/${'a'.repeat(1980)}`)).toBe('accepted');
    expect(refusal(`https://example.com/${'a'.repeat(1981)}`)).toContain('2000');
    for (const url of ['https://exa\nmple.com/', 'https://example.com/a b', ' https://example.com/', 'https://example.com/\t', 'https:\\\\example.com\\', 'https://example.com\\@evil.example.org/', 'https://example.com/\u0000']) {
      expect([JSON.stringify(url), refusal(url)]).not.toEqual([JSON.stringify(url), 'accepted']);
    }
  });
});

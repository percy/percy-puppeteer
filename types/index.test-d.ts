import { expectType, expectError } from 'tsd';
import * as Puppeteer from 'puppeteer-core/lib/cjs/puppeteer/common/Page';
import percySnapshot from '.';

declare const page: Puppeteer.Page;

expectError(percySnapshot());
expectError(percySnapshot(page));
expectError(percySnapshot('Snapshot name'));

expectType<Promise<void>>(percySnapshot(page, 'Snapshot name'));
expectType<Promise<void>>(percySnapshot(page, 'Snapshot name', { widths: [1000] }));

expectError(percySnapshot(page, 'Snapshot name', { foo: 'bar' }));

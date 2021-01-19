import * as Puppeteer from 'puppeteer-core/lib/cjs/puppeteer/common/Page';
import { SnapshotOptions } from '@percy/core';

export default function percySnapshot(
  page: Puppeteer.Page,
  name: string,
  options?: SnapshotOptions
): Promise<void>;

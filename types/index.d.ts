import { SnapshotOptions } from '@percy/core';
import { Page } from 'puppeteer';

export default function percySnapshot(
  page: Page,
  name: string,
  options?: SnapshotOptions
): Promise<void>;

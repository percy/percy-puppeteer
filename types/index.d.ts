import * as Puppeteer from 'puppeteer';
import { SnapshotOptions } from '@percy/core';

export default function percySnapshot(
  page: Puppeteer.Page,
  name: string,
  options?: SnapshotOptions
): Promise<void>;

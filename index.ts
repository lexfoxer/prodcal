/// <reference types="bun-types" />

import * as cheerio from 'cheerio';
import { customAlphabet } from 'nanoid'

const makeId = customAlphabet('1234567890abcdef', 50);

function getUrl(year: number) {
  return `https://hh.ru/article/calendar${year}`;
}

function text(strings: TemplateStringsArray, ...param: any) {
  return strings.raw.map((el, index) => {
    const template = el.replace(/\n.\s{2,}/gi, '\n').replace(/^\n/gi, '');
    return template + (param[index] || '');
  }).join('\n').trim();
}

const formatDate = (date: string, sep: string = '') => 
  date.split('-')
    .map(el => el.padStart(2, '0'))
    .join(sep);

function createEvent(params: { start: string, end: string, message?: string }) {
  const end = new Date(
      new Date(formatDate(params.end, '-'))
        .getTime() + (24 * 60 * 60 * 1000)
    )
    .toISOString()
    .split('T')[0];

  return text`
    BEGIN:VEVENT
    SUMMARY:${params.message}
    DTSTART;VALUE=DATE:${formatDate(params.start)}
    DTEND;VALUE=DATE:${formatDate(end)}
    UID:${makeId()}
    END:VEVENT
  `;
}

function makeGroups(holydayOffList: Map<string, { message: string; holyday: boolean; shortened: boolean; }>) {
  const sortedDates = [...holydayOffList.keys()]
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  const groups = sortedDates.reduce<{
    start: string;
    end: string;
    message?: string;
  }[]>((acc, el) => {
    const prevDateEnd = acc.length
      ? new Date(acc[acc.length - 1].end).getTime()
      : null;
    const currDate = new Date(el).getTime();

    const dateStartParams = holydayOffList.get(el);

    if (
      prevDateEnd
      && dateStartParams?.message === acc[acc.length - 1].message
      && currDate - prevDateEnd === 24 * 60 * 60 * 1000
    ) {
      if (acc[acc.length - 1])
        acc[acc.length - 1] = {...acc[acc.length - 1], end: el};
      return acc;
    }

    acc.push({ start: el, end: el, message: dateStartParams?.message });
    return acc;
  }, []);

  return groups;
}

async function fetchData({ fullYear }: { fullYear: number }) {
  const response = await fetch(getUrl(fullYear), {
    method: 'GET',
    headers: { 'User-Agent': 'curl/7.68.0' }
  });

  if (response.status !== 200) throw new Error('Cannot fetch data');

  const html = await response.text();

  return html;
}

async function parseData($: cheerio.CheerioAPI, year: string) {
  const months = $('.calendar-list__item .calendar-list__item-body:first-child');

  const dayOffList = new Map<string, {
    message: string;
    holyday: boolean;
    shortened: boolean;
  }>()

  months.each((monthIndex, element) => {
    const dayItem = $(element).find('.calendar-list__numbers__item');

    dayItem.each((_, day) => {
      const isDayOff = $(day)
        .hasClass('calendar-list__numbers__item_day-off');

      const isShortened = $(day)
        .hasClass('calendar-list__numbers__item_shortened');

      if (!isDayOff && !isShortened) return;

      const dayNumber = $(day)
        .contents()
        .filter((_, el) => el.type === 'text')
        .text().trim();

      const dayMessage = isShortened
        ? 'Предпраздничный день, на 1 час короче'
        : $(day)
          .find('.calendar-hint')
          .text().trim()
          .replace('Выходной день', 'Выходной')

      const dayKey = `${year}-${monthIndex+1}-${dayNumber}`;
      dayOffList.set(dayKey, {
        message: dayMessage,
        holyday: isDayOff,
        shortened: isShortened,
      });
    });
  });

  return dayOffList;
}

function parseCliYear(argv: string[]): string {
  // Supports:
  // - bun run index.ts --year 2026
  // - bun run index.ts --year=2026
  // - bun run index.ts 2026
  const nowYear = String(new Date().getFullYear());

  const yearFlagIndex = argv.findIndex((a) => a === '--year' || a === '-y');
  const yearFromFlag =
    yearFlagIndex !== -1
      ? argv[yearFlagIndex + 1]
      : (argv.find((a) => a.startsWith('--year='))?.split('=')[1]);

  const yearFromPositional = argv.find((a) => /^\d{4}$/.test(a));

  const year = (yearFromFlag ?? yearFromPositional ?? nowYear)?.trim();

  if (!year || !/^\d{4}$/.test(year)) {
    throw new Error('Year is required. Use --year 2026 (or pass 2026 as positional arg).');
  }

  const asNumber = Number(year);
  if (asNumber < 2020 || asNumber > 2100) {
    throw new Error('Year looks invalid. Expected a year between 2020 and 2100.');
  }

  return year;
}

async function main() {
  const year = parseCliYear(Bun.argv.slice(2));

  const html = await fetchData({ fullYear: +year });

  const $ = cheerio.load(html);

  const holydayOffList = await parseData($, year);

  const arr: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Work calendar//ical.lexfoxer.com/work//RU',
    'X-WR-CALNAME:Производственный календарь',
    'NAME:Производственный календарь',
  ];

  const groups = makeGroups(holydayOffList);

  groups.forEach((el) => {
    const event = createEvent(el);
    arr.push(event);
  })

  arr.push('END:VCALENDAR');

  await Bun.write(`${year}.ics`, arr.join('\n'));
}

(async () => {
  main();
})();

#include "time.h"

/* Convert a day count since 1970-01-01 into a (year, month, day) civil date.
 * This is Howard Hinnant's well-known, exhaustively tested algorithm for
 * the proleptic Gregorian calendar (http://howardhinnant.github.io/date_algorithms.html),
 * reproduced here so we don't need a real OS/libc localtime(). It has no
 * branches and is valid over a huge date range, which matters because
 * SQLite's date functions accept a very wide range of julian-day inputs.
 */
static void civil_from_days(long z, int *y, unsigned *m, unsigned *d) {
    z += 719468; /* shift epoch from 1970-01-01 to 0000-03-01 */
    long era = (z >= 0 ? z : z - 146096) / 146097;
    unsigned doe = (unsigned)(z - era * 146097);                 /* [0, 146096] */
    unsigned yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365; /* [0, 399] */
    long yr = (long)yoe + era * 400;
    unsigned doy = doe - (365*yoe + yoe/4 - yoe/100);             /* [0, 365] */
    unsigned mp = (5*doy + 2)/153;                                /* [0, 11] */
    *d = doy - (153*mp+2)/5 + 1;                                  /* [1, 31] */
    *m = mp + (mp < 10 ? 3 : -9);                                 /* [1, 12] */
    *y = (int)(yr + (*m <= 2));
}

/* Local time is treated as UTC: there is no timezone database available in
 * this freestanding wasm environment (see the note in time.h). */
struct tm *localtime(const time_t *timer) {
    static struct tm result;

    long secs_total = (long)*timer;
    long days = secs_total / 86400;
    long rem  = secs_total % 86400;
    if (rem < 0) { rem += 86400; days -= 1; }

    int hour = (int)(rem / 3600);
    int min  = (int)((rem % 3600) / 60);
    int sec  = (int)(rem % 60);

    int year; unsigned mon, mday;
    civil_from_days(days, &year, &mon, &mday);

    /* 1970-01-01 was a Thursday. */
    int wday = (int)(((days % 7) + 7 + 4) % 7);

    /* Day-of-year via the days-since-epoch of Jan 1 of the same year. */
    long jan1_days;
    {
        long z = (long)year;
        long era = (z >= 0 ? z : z - 399) / 400;
        unsigned yoe = (unsigned)(z - era * 400);
        long doe = yoe*365 + yoe/4 - yoe/100; /* days from 0000-03-01 to Jan 1 of `year` minus offset handled below */
        /* days from civil epoch (1970-01-01) to March 1 of `year - 1` */
        jan1_days = era * 146097 + (long)doe - 719468 + 306; /* +306 = days from Mar1(year-1) to Jan1(year) */
    }
    int yday = (int)(days - jan1_days);

    result.tm_sec  = sec;
    result.tm_min  = min;
    result.tm_hour = hour;
    result.tm_mday = (int)mday;
    result.tm_mon  = (int)mon - 1;   /* 0-based */
    result.tm_year = year - 1900;
    result.tm_wday = wday;
    result.tm_yday = yday;
    result.tm_isdst = 0;

    return &result;
}

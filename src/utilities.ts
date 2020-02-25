
export function groupBy<T extends Record<TKey, string>, TKey extends string>(array: T[], key: TKey) : { [key: string]: T[] } {
    return array.reduce((rv, x) => {
        (rv[x[key]] = rv[x[key]] || []).push(x);
        return rv;
    }, <{ [key: string]: T[] }>({}));
};
export function flatMap<TOut, TIn>(arr: TIn[], f: (t: TIn) => TOut[]): TOut[] {
    return arr.reduce((ys: any, x: any) => {
        return ys.concat(f.call(null, x))
    }, []);
}

export function flatten<T>(arr: T[][]): T[] {
    return arr.reduce((ys: any, x: any) => {
        return ys.concat(x)
    }, []);
}

export function endsWith(str: string, suffix: string) {
    return str.substr(-suffix.length) == suffix;
}

export function capitalize(string: string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

export function decapitalize(string: string) {
    return string.charAt(0).toLowerCase() + string.slice(1);
}

/**
 * Groups items in an array by common keys
 * @param items the input items
 * @param keyFn a function that computes the key value of an item
 * @returns {Map<TKey, TItem[]>} a map from key values to the list of items that have that key
 */
export function groupArray<TItem, TKey>(items: TItem[], keyFn: (item: TItem) => TKey): Map<TKey, TItem[]> {
    const map = new Map<TKey, TItem[]>();
    for (const item of items) {
        const key = keyFn(item);
        let group = map.get(key);
        if (!group) {
            group = [];
            map.set(key, group);
        }
        group.push(item);
    }
    return map;
}

export const INDENTATION = '  ';

/**
 * Indents each line of a string with a given indentation
 * @param input the string to indent
 * @param indentation the prefix to put in front of each line
 * @returns the indented string
 */
export function indent(input: string, indentation: string|number = INDENTATION) {
    if (typeof indentation == 'number') {
        indentation = INDENTATION.repeat(indentation);
    }
    return input.split('\n').map(line => indentation + line).join('\n');
}

/**
 * Creates an array of the form [0, 1, 2, ..., count-1]
 *
 * @param count the number of items for the array
 * @returns the array
 */
export function range(count: number): number[] {
    return [...Array(count).keys()];
}

/**
 * Executes a given asynchronous function {@code count} times in parallel
 * @param fn the function to call
 * @param count the number of times to call the function
 * @returns {Promise<number[]>} a promise that resolves when all function calls have been completed, with a list of their results
 */
export async function doXTimesInParallel<T>(fn: () => Promise<T>, count: number): Promise<T[]> {
    return Promise.all(range(count).map(a => fn()));
}

/**
 * Takes a random sample of an array
 * @param arr the source population
 * @returns the sampled item, or undefined if the input array is empty
 */
export function takeRandomSample<T>(arr: T[]): T|undefined {
    return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Takes {@code count} samples randomly of the given array. The same sample may occur mulitple times
 * @param arr the source population
 * @param count the number of samples
 * @returns the samples, or undefined if the input array is empty
 */
export function takeRandomSamples<T>(arr: T[], count: number): T[]|undefined {
    if (arr.length == 0) {
        return undefined;
    }
    return range(count).map(() => takeRandomSample(arr)!);
}

export function removeDuplicates<T, U>(list: T[], keyFn: (item: T) => U): T[] {
    const existingKeys = new Set<U>();
    return list.filter(item => {
        const key = keyFn(item);
        if (existingKeys.has(key)) {
            return false;
        }
        existingKeys.add(key);
        return true;
    });
}

export function arrayToObject<TValue>(array: TValue[], keyFn: (obj: TValue) => string): { [name: string]: TValue } {
    const result: { [name: string]: TValue } = {};
    for (const item of array) {
        result[keyFn(item)] = item;
    }
    return result;
}

export function compact<T>(arr: (T | undefined | null)[]): T[] {
    return arr.filter(a => a != undefined) as T[];
}
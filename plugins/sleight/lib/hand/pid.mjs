// The ghost hand host's pid, so pointer tools and cover checks can ignore its window.
let pid = 0;
export const handPid = () => pid;
export const setHandPid = value => { pid = Number.isSafeInteger(value) && value > 0 ? value : 0; };

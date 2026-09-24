export const session = { profile: null };
export const can = (p) => !!session.profile?.permissions?.includes(p);
export const canAny = (list) => list.some(can);

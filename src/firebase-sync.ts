import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { auth, db, googleAuthProvider } from './firebase.ts';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function clampStr(val: unknown, max: number, fallback = ''): string {
  const s = typeof val === 'string' ? val : String(val ?? fallback);
  return s.slice(0, max);
}

function clampNum(val: unknown, min: number, max: number, fallback = 0): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

let currentUser: User | null = null;
let userDocReady = false;
let settingsTimer: number | undefined;
let tableTimer: number | undefined;

async function ensureUserDoc(user: User): Promise<void> {
  const userPath = `users/${user.uid}`;
  const privatePath = `users/${user.uid}/private/info`;
  const displayName = clampStr(user.displayName || user.email?.split('@')[0] || 'Usuario', 80) || 'Usuario';
  const photoUrl = clampStr(user.photoURL || '', 500);

  try {
    const userRef = doc(db, 'users', user.uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      const payload: Record<string, unknown> = {
        uid: user.uid,
        displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (photoUrl) payload.photoUrl = photoUrl;
      await setDoc(userRef, payload);
    } else {
      const updatePayload: Record<string, unknown> = {
        displayName,
        updatedAt: serverTimestamp(),
      };
      if (photoUrl) updatePayload.photoUrl = photoUrl;
      await updateDoc(userRef, updatePayload);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }

  if (user.email) {
    try {
      const privRef = doc(db, 'users', user.uid, 'private', 'info');
      await setDoc(
        privRef,
        {
          uid: user.uid,
          email: clampStr(user.email, 254),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, privatePath);
    }
  }

  userDocReady = true;
}

function sanitizeSettings(S: Record<string, any>, uid: string) {
  const names = Array.isArray(S.names)
    ? S.names.slice(0, 6).map((x) => clampStr(x, 40, 'Jugador'))
    : ['Jugador 1', 'Jugador 2', 'Jugador 3', 'Jugador 4', 'Jugador 5', 'Jugador 6'];
  const colors = Array.isArray(S.colors)
    ? S.colors.slice(0, 6).map((x) => clampStr(x, 20, '#ffffff'))
    : ['#f1f5f9', '#facc15', '#22d3ee', '#f472b6', '#a3e635', '#fb923c'];
  const inv = Array.isArray(S.inv)
    ? S.inv.slice(0, 100).map((p) => ({
        n: clampStr(p?.n ?? 'Producto', 60),
        p: clampNum(p?.p, 0, 100000000, 0),
        s: clampNum(p?.s, 0, 100000, 0),
        m: clampNum(p?.m, 0, 100000, 0),
      }))
    : [];

  return {
    uid,
    sala: clampStr(S.sala || 'BILLAR PRO', 80) || 'BILLAR PRO',
    nit: clampStr(S.nit || '', 40),
    tel: clampStr(S.tel || '', 40),
    dir: clampStr(S.dir || '', 160),
    taxN: clampStr(S.taxN || 'IVA', 30) || 'IVA',
    tax: clampNum(S.tax, 0, 100, 19),
    taxOn: Boolean(S.taxOn),
    rate: clampNum(S.rate, 0, 100000000, 17000),
    sym: clampStr(S.sym || '$', 6) || '$',
    loc: clampStr(S.loc || 'es-CO', 12) || 'es-CO',
    dec: clampNum(S.dec, 0, 4, 0),
    lang: clampStr(S.lang || 'es', 8) || 'es',
    theme: clampStr(S.theme || 'neon', 16) || 'neon',
    model: clampStr(S.model || '1', 4) || '1',
    n: clampNum(S.n, 2, 6, 2),
    mesa: clampNum(S.mesa, 1, 999, 1),
    mem: clampNum(S.mem, 1, 120, 5),
    delay: clampNum(S.delay, 0, 120, 10),
    fac: clampNum(S.fac, 0, 999999999, 0),
    names,
    colors,
    inv,
    updatedAt: serverTimestamp(),
  };
}

function sanitizeTableState(st: Record<string, any>, uid: string) {
  const sc = Array.from({ length: 6 }, (_, i) => clampNum(st.sc?.[i], 0, 999999, 0));
  const sets = Array.from({ length: 6 }, (_, i) => clampNum(st.sets?.[i], 0, 999999, 0));
  const names = Array.from({ length: 6 }, (_, i) =>
    clampStr(st.names?.[i] || `Jugador ${i + 1}`, 40)
  );
  const rawCart = st.cart && typeof st.cart === 'object' ? st.cart : {};
  const cart: Record<string, number> = {};
  Object.entries(rawCart)
    .slice(0, 100)
    .forEach(([k, v]) => {
      const qty = clampNum(v, 0, 9999, 0);
      if (qty > 0) cart[clampStr(k, 60)] = qty;
    });

  return {
    uid,
    sc,
    sets,
    names,
    n: clampNum(st.n, 2, 6, 2),
    el: clampNum(st.el, 0, 1000000000, 0),
    run: Boolean(st.run),
    last: clampNum(st.last, 0, 9999999999999, Date.now()),
    cart,
    mesa: clampNum(st.mesa, 1, 999, 1),
    rate: clampNum(st.rate, 0, 100000000, 17000),
    closed: Boolean(st.closed),
    updatedAt: serverTimestamp(),
  };
}

const BPCloud = {
  get user() {
    return currentUser;
  },
  isReady() {
    return Boolean(currentUser && userDocReady);
  },
  async signIn(): Promise<User | null> {
    const res = await signInWithPopup(auth, googleAuthProvider);
    if (res.user) {
      currentUser = res.user;
      await ensureUserDoc(res.user);
    }
    return res.user;
  },
  async signOut(): Promise<void> {
    userDocReady = false;
    await signOut(auth);
  },
  async loadAll(mesaId = 1): Promise<{
    settings: Record<string, any> | null;
    table: Record<string, any> | null;
    sales: Record<string, any>[];
    expenses: Record<string, any>[];
  } | null> {
    if (!currentUser || !userDocReady) return null;
    const uid = currentUser.uid;
    const settingsPath = `users/${uid}/club/settings`;
    const tablePath = `users/${uid}/tables/${mesaId}`;
    const salesPath = `users/${uid}/sales`;
    const expensesPath = `users/${uid}/expenses`;

    let settings: Record<string, any> | null = null;
    let table: Record<string, any> | null = null;
    const sales: Record<string, any>[] = [];
    const expenses: Record<string, any>[] = [];

    try {
      const sSnap = await getDoc(doc(db, 'users', uid, 'club', 'settings'));
      if (sSnap.exists()) settings = sSnap.data();
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, settingsPath);
    }

    try {
      const tSnap = await getDoc(doc(db, 'users', uid, 'tables', String(mesaId)));
      if (tSnap.exists()) table = tSnap.data();
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, tablePath);
    }

    try {
      const sq = query(collection(db, 'users', uid, 'sales'), orderBy('d', 'desc'), limit(200));
      const sList = await getDocs(sq);
      sList.forEach((d) => sales.push({ id: d.id, ...d.data() }));
      sales.reverse();
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, salesPath);
    }

    try {
      const eq = query(collection(db, 'users', uid, 'expenses'), orderBy('d', 'desc'), limit(200));
      const eList = await getDocs(eq);
      eList.forEach((d) => expenses.push({ id: d.id, ...d.data() }));
      expenses.reverse();
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, expensesPath);
    }

    return { settings, table, sales, expenses };
  },
  saveSettings(S: Record<string, any>): void {
    if (!currentUser || !userDocReady) return;
    const uid = currentUser.uid;
    window.clearTimeout(settingsTimer);
    settingsTimer = window.setTimeout(async () => {
      const path = `users/${uid}/club/settings`;
      try {
        await setDoc(doc(db, 'users', uid, 'club', 'settings'), sanitizeSettings(S, uid));
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, path);
      }
    }, 600);
  },
  saveTable(st: Record<string, any>): void {
    if (!currentUser || !userDocReady) return;
    const uid = currentUser.uid;
    const mesaId = String(clampNum(st.mesa, 1, 999, 1));
    window.clearTimeout(tableTimer);
    tableTimer = window.setTimeout(async () => {
      const path = `users/${uid}/tables/${mesaId}`;
      try {
        await setDoc(doc(db, 'users', uid, 'tables', mesaId), sanitizeTableState(st, uid));
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, path);
      }
    }, 500);
  },
  async recordSale(sale: Record<string, any>): Promise<void> {
    if (!currentUser || !userDocReady) return;
    const uid = currentUser.uid;
    const saleId = `sale_${clampNum(sale.d, 1, 9999999999999, Date.now())}_${clampNum(sale.no, 0, 999999, 0)}`;
    const path = `users/${uid}/sales/${saleId}`;
    try {
      await setDoc(doc(db, 'users', uid, 'sales', saleId), {
        uid,
        no: clampNum(sale.no, 0, 9999999, 0),
        mesa: clampNum(sale.mesa, 1, 999, 1),
        d: clampNum(sale.d, 1, 9999999999999, Date.now()),
        cons: clampNum(sale.cons, 0, 1000000000, 0),
        time: clampNum(sale.time, 0, 1000000000, 0),
        tax: clampNum(sale.tax, 0, 1000000000, 0),
        tot: clampNum(sale.tot, 0, 1000000000, 0),
        winner: clampStr(sale.winner || '', 80),
        createdAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  },
  async recordExpense(exp: Record<string, any>): Promise<string | null> {
    if (!currentUser || !userDocReady) return null;
    const uid = currentUser.uid;
    const expId = `exp_${clampNum(exp.d, 1, 9999999999999, Date.now())}`;
    const path = `users/${uid}/expenses/${expId}`;
    try {
      await setDoc(doc(db, 'users', uid, 'expenses', expId), {
        uid,
        d: clampNum(exp.d, 1, 9999999999999, Date.now()),
        n: clampStr(exp.n || 'Gasto', 120) || 'Gasto',
        v: clampNum(exp.v, 1, 1000000000, 1),
        createdAt: serverTimestamp(),
      });
      return expId;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  },
  async deleteExpense(expId: string): Promise<void> {
    if (!currentUser || !userDocReady || !expId) return;
    const uid = currentUser.uid;
    const path = `users/${uid}/expenses/${expId}`;
    try {
      await deleteDoc(doc(db, 'users', uid, 'expenses', expId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  },
};

(window as any).BPCloud = BPCloud;

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  userDocReady = false;
  if (user) {
    try {
      await ensureUserDoc(user);
    } catch (err) {
      console.error('Auth sync error:', err);
    }
  }
  window.dispatchEvent(new CustomEvent('bp-auth-changed', { detail: { user } }));
});

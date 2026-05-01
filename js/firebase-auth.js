// ── Firebase Config & Init ───────────────────────────────────────────────────

firebase.initializeApp({
  apiKey: "AIzaSyAlx8QBfnrwKj0a7ULWZ4vMOZW23_Bhuzg",
  authDomain: "imobdata-90ee3.firebaseapp.com",
  projectId: "imobdata-90ee3",
  storageBucket: "imobdata-90ee3.firebasestorage.app",
  messagingSenderId: "677304770746",
  appId: "1:677304770746:web:a61238802501e1879ba283",
  measurementId: "G-9J7DJNFP6L"
});

const auth = firebase.auth();
const db   = firebase.firestore();
window.currentUser = null;

let _carteirasCache    = null;
let _carteirasCacheUid = null;
let _carteirasInflight = null;

function invalidarCacheCarteiras() {
  _carteirasCache = null;
  _carteirasCacheUid = null;
}

function getCarteirasCache() {
  const uid = window.currentUser?.uid || null;
  if (_carteirasCache !== null && _carteirasCacheUid === uid) return _carteirasCache;
  return null;
}

// ── Auth State ───────────────────────────────────────────────────────────────

auth.onAuthStateChanged(user => {
  const novoUid = user?.uid || null;
  if (novoUid !== _carteirasCacheUid) invalidarCacheCarteiras();
  window.currentUser = user;
  document.dispatchEvent(new Event("auth-state-changed"));
});

// ── Auth Functions ───────────────────────────────────────────────────────────

async function loginEmail(email, password) {
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (e) { alertAuth(e); }
}

async function signupEmail(email, password) {
  try {
    await auth.createUserWithEmailAndPassword(email, password);
  } catch (e) { alertAuth(e); }
}

async function loginGoogle() {
  try {
    await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
  } catch (e) { alertAuth(e); }
}

function logout() { auth.signOut(); }

async function resetSenha(email) {
  if (!email) { alert("Digite seu email primeiro."); return; }
  try {
    await auth.sendPasswordResetEmail(email);
    alert("Enviamos um email com o link para redefinir sua senha. Confira sua caixa de entrada (e o spam).");
  } catch (e) { alertAuth(e); }
}

function alertAuth(e) {
  const msgs = {
    "auth/invalid-email": "Email inválido.",
    "auth/missing-email": "Digite seu email primeiro.",
    "auth/user-not-found": "Usuário não encontrado.",
    "auth/wrong-password": "Senha incorreta.",
    "auth/email-already-in-use": "Email já cadastrado.",
    "auth/weak-password": "Senha deve ter pelo menos 6 caracteres.",
    "auth/invalid-credential": "Email ou senha incorretos.",
    "auth/too-many-requests": "Muitas tentativas. Tente novamente em alguns minutos.",
    "auth/network-request-failed": "Falha de conexão. Verifique sua internet.",
  };
  alert(msgs[e.code] || e.message);
}

// ── Firestore CRUD ───────────────────────────────────────────────────────────

const MAX_CARTEIRAS = 30;

function userCarteirasRef() {
  if (!window.currentUser) return null;
  return db.collection("users").doc(window.currentUser.uid).collection("carteiras");
}

async function listarCarteiras() {
  const uid = window.currentUser?.uid || null;
  if (!uid) return [];
  if (_carteirasCache !== null && _carteirasCacheUid === uid) return _carteirasCache;
  if (_carteirasInflight) return _carteirasInflight;

  _carteirasInflight = (async () => {
    const ref = userCarteirasRef();
    if (!ref) return [];
    const t0 = performance.now();
    const snap = await ref.get();
    console.log(`[carteiras] fetch: ${(performance.now() - t0).toFixed(0)}ms (${snap.size} docs, fromCache=${snap.metadata.fromCache})`);
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _carteirasCache = docs.sort((a, b) => {
      const tA = a.updated_at?.toMillis?.() || 0;
      const tB = b.updated_at?.toMillis?.() || 0;
      return tB - tA;
    });
    _carteirasCacheUid = uid;
    return _carteirasCache;
  })();

  try {
    return await _carteirasInflight;
  } finally {
    _carteirasInflight = null;
  }
}

async function salvarCarteiraFirestore(id, data) {
  const ref = userCarteirasRef();
  if (!ref) return null;
  data.updated_at = firebase.firestore.Timestamp.now();
  if (id) {
    await ref.doc(id).set(data, { merge: true });
    invalidarCacheCarteiras();
    return id;
  } else {
    const snap = await ref.get();
    if (snap.size >= MAX_CARTEIRAS) {
      const err = new Error(`Limite de ${MAX_CARTEIRAS} carteiras atingido. Exclua alguma para criar uma nova.`);
      err.code = "limit-exceeded";
      throw err;
    }
    const doc = await ref.add(data);
    invalidarCacheCarteiras();
    return doc.id;
  }
}

async function carregarCarteiraFirestore(id) {
  const ref = userCarteirasRef();
  if (!ref) return null;
  const doc = await ref.doc(id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function deletarCarteiraFirestore(id) {
  const ref = userCarteirasRef();
  if (!ref) return;
  await ref.doc(id).delete();
  invalidarCacheCarteiras();
}

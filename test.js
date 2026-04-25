const safeLogs = [{ text: "(Administrador Maestro)  asdfasdf", date: "2026-04-25T18:29:55.772Z", auto: false }];
const currentUser = { role: "manager" };
const p = { id: "123" };
const origLen = 1;
safeLogs.forEach((l, i) => {
    const realIdx = origLen - 1 - i;
    let deleteBtn = '';
    if (l.auto !== true && l.auto !== 'true') {
        if (currentUser && (currentUser.role === 'manager' || currentUser.role === 'gestor')) {
            deleteBtn = `<span class="cursor-pointer" style="margin-left:10px; font-size:0.75rem; color:var(--danger); font-weight:bold; text-decoration:underline;" onclick="deleteLog('${p.id}', ${realIdx})">[Eliminar]</span>`;
        }
    }
    console.log(deleteBtn);
});

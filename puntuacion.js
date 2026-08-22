// ============================================================================
// puntuacion.js · ÚNICA fuente de cálculo de la Porra Champions 26/27
// Lo usa SOLO quien escribe puntos (admin al guardar un resultado real).
// Las páginas que muestran (resultados/ranking) NO calculan: leen `puntuaciones`.
//
// calcularTodos(datos) -> [ { user_id, nombre, total, r1_grupos, r2_playoff,
//                             r3_elim, r4_pos, detalle } ]
//
// datos = {
//   reglas,          // fila de config_reglas
//   posLigaReal,     // { equipo_id: puesto(1-36) }   (resultado_liga)
//   playoffReal,     // [ equipo_id, ... ]            (resultado_playoff, los que pasan)
//   cruces,          // { cruce_id: fila bracket_cruces }  (cuadro REAL)
//   jugadores: [ {
//       uid, nombre,
//       grupos,      // { equipo_id: puesto }         (pronostico_grupos)
//       playoff,     // [ equipo_id, ... ]            (pronostico_playoff)
//       elim         // { cruce_id: {gl,gv,gana} }    (pronostico_eliminatorias)
//   } ]
// }
//
// NOTA sobre acumulación de puntos (confirmar con el usuario):
//   · Grupos: rango y puesto exacto SUMAN (acertar el puesto da rango+puesto).
//   · Eliminatorias: emparejamiento + ganador + exacto SUMAN por partido.
//   Si se prefiere exclusivo, es un cambio localizado en las funciones r1/r3.
// ============================================================================

const banda = pos => pos<=8 ? 'D' : pos<=24 ? 'P' : 'F';

// Ganador de un cruce normalizado {equipo_local,equipo_visitante,gl,gv,gana}
function ganadorDe(m){
  if(!m || m.equipo_local==null || m.equipo_visitante==null) return null;
  if(m.gl==null || m.gv==null) return null;
  if(m.gl > m.gv) return m.equipo_local;
  if(m.gv > m.gl) return m.equipo_visitante;
  return m.gana || null;            // empate a 90' -> quien pasa
}

// Profundidad final de un equipo en un cuadro (1/2/S/C/O) o null si aún no cae.
// crucesArr: cruces normalizados. Devuelve el tier de la ronda donde PERDIÓ (o '1' si campeón).
function profundidad(team, crucesArr){
  const F = crucesArr.find(c=>c.ronda==='F');
  if(F && ganadorDe(F)===team) return '1';
  for(const [ronda,tier] of [['F','2'],['SF','S'],['QF','C'],['R16','O']]){
    for(const c of crucesArr.filter(x=>x.ronda===ronda)){
      if(c.equipo_local===team || c.equipo_visitante===team){
        const w = ganadorDe(c);
        if(w && w!==team) return tier;   // jugó esta ronda y la perdió
      }
    }
  }
  return null;   // aún no eliminado (o sin datos) -> sin R4 todavía
}

// Normaliza el cuadro real (nombres de campos de la BD -> genéricos)
function normReal(cruces){
  const out = {};
  for(const id in cruces){
    const c = cruces[id];
    out[id] = { id, ronda:c.ronda, idx:c.idx,
      equipo_local:c.equipo_local, equipo_visitante:c.equipo_visitante,
      gl:c.goles_local, gv:c.goles_visitante, gana:c.ganador_id,
      feeds_id:c.feeds_id, feeds_pos:c.feeds_pos };
  }
  return out;
}

// Construye el cuadro del JUGADOR: octavos = equipos reales; cuartos+ derivados
// de los ganadores que el propio jugador predice, subiendo por feeds_*.
function cuadroJugador(realN, elim){
  const uc = {};
  for(const id in realN){
    const c = realN[id];
    uc[id] = { id, ronda:c.ronda, idx:c.idx,
      equipo_local: c.ronda==='R16' ? c.equipo_local : null,
      equipo_visitante: c.ronda==='R16' ? c.equipo_visitante : null,
      gl:null, gv:null, gana:null, feeds_id:c.feeds_id, feeds_pos:c.feeds_pos };
  }
  // resultados del jugador
  for(const id in uc){ const p = elim[id]; if(p){ uc[id].gl=p.gl; uc[id].gv=p.gv; uc[id].gana=p.gana; } }
  // propagar ganadores R16 -> QF -> SF -> F
  ['R16','QF','SF'].forEach(r=>{
    Object.values(uc).filter(m=>m.ronda===r).forEach(m=>{
      const w = ganadorDe(m);
      if(w && m.feeds_id && uc[m.feeds_id]){
        uc[m.feeds_id][ m.feeds_pos==='local' ? 'equipo_local' : 'equipo_visitante' ] = w;
      }
    });
  });
  return uc;
}

const mismoSet = (a1,a2,b1,b2) =>
  (a1===b1 && a2===b2) || (a1===b2 && a2===b1);

// ---- Cálculo de un jugador ----
function calcularJugador(j, ctx){
  const { reglas, posLigaReal, playoffReal, realN, realArr, r16Teams, realDepth } = ctx;
  const det = { grupos:{}, playoff:{}, elim:{}, posfinal:{} };
  let r1=0, r2=0, r3=0, r4=0;

  // R1 · Grupos (filas = los 36 con posición real conocida)
  for(const eq in posLigaReal){
    const real = posLigaReal[eq];
    const prev = j.grupos ? j.grupos[eq] : undefined;
    let p = 0;
    if(prev!=null){
      if(banda(prev)===banda(real)) p += reglas.grupos_rango;
      if(prev===real)              p += reglas.grupos_puesto;
    }
    det.grupos[eq] = { pos_prevista: prev??null, pos_real: real, puntos: p };
    r1 += p;
  }

  // R2 · Playoff (filas = los que pasan de verdad)
  const prevSet = new Set(j.playoff||[]);
  for(const eq of playoffReal){
    const previsto = prevSet.has(eq);
    const p = previsto ? reglas.playoff_equipo : 0;
    det.playoff[eq] = { previsto, real:true, puntos:p };
    r2 += p;
  }

  // R3 · Eliminatorias (por cruce; compara por EQUIPOS, no por casilla)
  const uc = cuadroJugador(realN, j.elim||{});
  for(const id in realN){
    const R = realN[id], U = uc[id];
    const rGana = ganadorDe(R), uGana = ganadorDe(U);
    let p = 0, empar=false, gan=false, exa=false;

    const teamsSet = (R.equipo_local && R.equipo_visitante && U.equipo_local && U.equipo_visitante
      && mismoSet(U.equipo_local,U.equipo_visitante,R.equipo_local,R.equipo_visitante));

    // Emparejamiento: solo cuartos, semis y final
    if(R.ronda!=='R16' && teamsSet){ empar=true; p += reglas.elim_emparejamiento; }
    // Ganador (a 90'): mismo equipo que pasa
    if(rGana && uGana && rGana===uGana){ gan=true; p += reglas.elim_ganador; }
    // Resultado exacto: mismos equipos y mismos goles por equipo
    if(teamsSet && R.gl!=null && R.gv!=null && U.gl!=null && U.gv!=null){
      const rg = { [R.equipo_local]:R.gl, [R.equipo_visitante]:R.gv };
      const ug = { [U.equipo_local]:U.gl, [U.equipo_visitante]:U.gv };
      if(rg[R.equipo_local]===ug[R.equipo_local] && rg[R.equipo_visitante]===ug[R.equipo_visitante]){
        exa=true; p += reglas.elim_exacto;
      }
    }
    det.elim[id] = {
      ronda:R.ronda, idx:R.idx,
      real:{ local:R.equipo_local, visitante:R.equipo_visitante, gl:R.gl, gv:R.gv, gana:rGana },
      pron:{ local:U.equipo_local, visitante:U.equipo_visitante, gl:U.gl, gv:U.gv, gana:uGana },
      empar, gan, exa, puntos:p
    };
    r3 += p;
  }

  // R4 · Posición final (filas = los 16 que llegaron a octavos de verdad)
  const userDepthArr = Object.values(uc);
  for(const eq of r16Teams){
    const real = realDepth[eq] || null;             // tier real (o null si sigue vivo)
    const prev = profundidad(eq, userDepthArr);      // tier previsto por el jugador
    let p = 0;
    if(real && prev){
      const fila = reglas.r4_matrix[prev];
      if(fila && fila[real]!=null) p = fila[real];
    }
    det.posfinal[eq] = { prevista: prev, real, puntos: p };
    r4 += p;
  }

  return { user_id:j.uid, nombre:j.nombre, total:r1+r2+r3+r4,
           r1_grupos:r1, r2_playoff:r2, r3_elim:r3, r4_pos:r4, detalle:det };
}

// ---- Cálculo de todos ----
export function calcularTodos(datos){
  const realN = normReal(datos.cruces || {});
  const realArr = Object.values(realN);
  // 16 equipos reales de octavos
  const r16Teams = [];
  realArr.filter(c=>c.ronda==='R16').forEach(c=>{
    if(c.equipo_local) r16Teams.push(c.equipo_local);
    if(c.equipo_visitante) r16Teams.push(c.equipo_visitante);
  });
  // profundidad real de cada uno
  const realDepth = {};
  r16Teams.forEach(eq=>{ realDepth[eq] = profundidad(eq, realArr); });

  const ctx = {
    reglas: datos.reglas,
    posLigaReal: datos.posLigaReal || {},
    playoffReal: datos.playoffReal || [],
    realN, realArr, r16Teams, realDepth
  };

  return (datos.jugadores||[])
    .map(j => calcularJugador(j, ctx))
    .sort((a,b)=> b.total - a.total);   // ya ordenado de más a menos
}

export const tick = (ms = 3) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

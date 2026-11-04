async page => {
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://localhost:3000/?tab=reversals-updated');
  const root=page.getByTestId('reversals-updated');
  await root.getByRole('heading',{name:'Trade & decision ledger'}).waitFor({timeout:90000});
  const before=await page.request.get('http://localhost:3000/api/reversals-updated?market=us&tf=1h');
  const baseline=await before.json();
  const mode=root.getByLabel('Cost reconstruction mode',{exact:true});
  const [costResponse]=await Promise.all([
    page.waitForResponse(r=>r.url().includes('/api/reversals-updated?')&&r.url().includes('costMode=reconstructed')),
    mode.selectOption('reconstructed'),
  ]);
  const costs=await costResponse.json();
  if(!costs.ok||!(costs.metrics.adjusted_avg_r<baseline.metrics.avg_r))throw new Error('Cost selection did not reduce headline expectancy');
  await root.getByText('Expectancy · after selected costs',{exact:true}).waitFor();
  await root.getByRole('columnheader',{name:'Selected-cost R',exact:true}).waitFor();
  await page.screenshot({path:'output/playwright/reversals-updated/cost-reconstruction.png'});
  await root.getByLabel('Financing cost bps per day',{exact:true}).fill('0.5');
  const [finResponse]=await Promise.all([
    page.waitForResponse(r=>r.url().includes('/api/reversals-updated?')&&r.url().includes('financingBpsPerDay=0.5')),
    root.getByLabel('Spread cost',{exact:true}).focus(),
  ]);
  const financed=await finResponse.json();
  if(!(financed.metrics.adjusted_avg_r<costs.metrics.adjusted_avg_r))throw new Error('Holding-time financing not applied');
  const [offResponse]=await Promise.all([
    page.waitForResponse(r=>r.url().includes('/api/reversals-updated?')&&r.url().includes('costMode=gross')),
    mode.selectOption('gross'),
  ]);
  const restored=await offResponse.json();
  if(Math.abs(restored.metrics.adjusted_avg_r-baseline.metrics.avg_r)>1e-12)throw new Error('Gross result was not restored');
  await root.getByRole('button',{name:'OANDA practice',exact:false}).click();
  await root.getByRole('heading',{name:'Trade & decision ledger'}).waitFor({timeout:90000});
  if(!(await mode.isDisabled()))throw new Error('Practice spread can be double charged');
  await page.setViewportSize({width:390,height:844});
  const widths=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
  if(widths.document>widths.viewport+1)throw new Error('Mobile overflow');
  await page.setViewportSize({width:1440,height:1080});
  if(errors.length)throw new Error(errors.join('\n'));
  return {result:'PASS',grossR:baseline.metrics.avg_r,spreadAdjustedR:costs.metrics.adjusted_avg_r,withFinancingR:financed.metrics.adjusted_avg_r,restoredR:restored.metrics.adjusted_avg_r,pageErrors:errors};
}
